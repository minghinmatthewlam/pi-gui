import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { sessionKey } from "@pi-gui/pi-sdk-driver";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import type {
  DesktopAppState,
  OrchestrationEvidenceRecord,
  OrchestrationChildThread,
  OrchestrationChildThreadStatus,
  OrchestrationChildTranscriptMessage,
  OrchestrationSupervisionLoop,
  OrchestrationSupervisionStatus,
  SendChildThreadFollowUpInput,
  SetChildSupervisionLoopInput,
  TimelineToolCall,
  TranscriptMessage,
} from "../src/desktop-state";
import { submitComposerToSession } from "./app-store-composer";
import type { AppStoreInternals } from "./app-store-internals";
import { latestSessionActivityAt, previewFromTranscript } from "./app-store-utils";
import {
  createChildThreadAction,
  createChildThreadPromptFromToolOutput,
  createChildThreadToolName,
  listThreadsAction,
  listThreadsRequestedFromToolOutput,
  listThreadsToolName,
  readThreadAction,
  readThreadIdFromToolOutput,
  readThreadToolName,
  sendMessageToThreadAction,
  sendMessageToThreadFromToolOutput,
  sendMessageToThreadToolName,
} from "./orchestration-runtime";
import type {
  CreateChildThreadToolDetails,
  ListThreadsToolDetails,
  OrchestrationThreadListEntry,
  ReadThreadToolDetails,
  SendMessageToThreadToolDetails,
} from "./orchestration-runtime";

const CHILD_TITLE_LIMIT = 56;
const MAX_CHILD_TRANSCRIPT_MESSAGES = 40;
const MAX_READ_THREAD_MESSAGES = 60;
const MAX_EVIDENCE_RECORDS_PER_CHILD = 80;
const DEFAULT_SUPERVISION_INTERVAL_MS = 60_000;
const MIN_SUPERVISION_INTERVAL_MS = 250;
const CHILD_START_TIMEOUT_MS = 10_000;
const CHILD_RUNNING_FAILURE_GRACE_MS = 1_000;
const pendingCreateChildThreadToolCalls = new Set<string>();
const execFileAsync = promisify(execFile);

interface SpawnChildThreadInput {
  readonly parentWorkspaceId: string;
  readonly parentSessionId: string;
  readonly prompt: string;
  readonly sourceToolCallId?: string;
}

interface CreatedChildThreadResult {
  readonly child: OrchestrationChildThread;
  readonly deliveryStatus: NonNullable<CreateChildThreadToolDetails["deliveryStatus"]>;
}

async function createChildThreadRecord(
  store: AppStoreInternals,
  input: SpawnChildThreadInput,
): Promise<CreatedChildThreadResult> {
  await store.initialize();
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("Child thread prompt cannot be empty.");
  }

  const parent = store.sessionFromState({
    workspaceId: input.parentWorkspaceId,
    sessionId: input.parentSessionId,
  });
  if (!parent) {
    throw new Error("Select a parent thread before spawning a child.");
  }

  const workspace = store.workspaceRefFromState(input.parentWorkspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${input.parentWorkspaceId}`);
  }

  const pendingKey = input.sourceToolCallId ? childToolCallKey(input) : undefined;
  if (pendingKey && pendingCreateChildThreadToolCalls.has(pendingKey)) {
    throw new Error("Child thread creation is already in progress.");
  }

  const existing = input.sourceToolCallId ? childForToolCall(store, input) : undefined;
  if (existing) {
    if (existing.status === "failed") {
      throw new Error(existing.latestTranscript || "Failed to start child thread.");
    }
    const childRef = childSessionRef(existing);
    await store.ensureSessionReady(childRef);
    return {
      child: existing,
      deliveryStatus: requireInitialPromptRun(store, childRef, prompt),
    };
  }

  if (pendingKey) {
    pendingCreateChildThreadToolCalls.add(pendingKey);
  }
  try {
    const createOptions = await store.buildCreateSessionOptions(input.parentWorkspaceId);
    const session = await store.driver.createSession(workspace, {
      ...createOptions,
      title: titleFromPrompt(prompt),
    });
    const childRef = session.ref;
    const key = sessionKey(childRef);
    store.sessionState.transcriptCache.set(key, []);
    store.sessionState.loadedTranscriptKeys.add(key);
    store.updateSessionConfig(childRef, session.config);
    await store.ensureSessionSubscription(childRef);

    const now = new Date().toISOString();
    const git = await workspaceGitRef(input.parentWorkspaceId, workspace.path);
    const status = toOrchestrationStatus(session.status, childRef, store);
    const child: OrchestrationChildThread = {
      id: randomUUID(),
      ...(input.sourceToolCallId ? { sourceToolCallId: input.sourceToolCallId } : {}),
      parentWorkspaceId: input.parentWorkspaceId,
      parentSessionId: input.parentSessionId,
      childWorkspaceId: childRef.workspaceId,
      childSessionId: childRef.sessionId,
      title: session.title || titleFromPrompt(prompt),
      goal: prompt,
      status,
      latestTranscript: session.preview || prompt,
      transcript: [],
      evidence: [
        {
          id: evidenceId("created", input.sourceToolCallId ?? childRef.sessionId),
          childThreadId: "",
          kind: "orchestrator_acceptance",
          source: "orchestrator-accepted",
          status: "accepted",
          title: "Child thread created",
          detail: prompt,
          parentSessionId: input.parentSessionId,
          childSessionId: childRef.sessionId,
          ...(git ? { git } : {}),
          createdAt: now,
        },
      ],
      supervisionLoop: createSupervisionLoop(status, now),
      createdAt: now,
      updatedAt: session.updatedAt || now,
    };
    const childWithEvidence = {
      ...child,
      evidence: child.evidence.map((record) => ({ ...record, childThreadId: child.id })),
    };

    store.state = {
      ...store.state,
      orchestrationChildren: projectOrchestrationChildren(store, [
        childWithEvidence,
        ...store.state.orchestrationChildren,
      ]),
    };
    await store.refreshState({
      selectedWorkspaceId: input.parentWorkspaceId,
      selectedSessionId: input.parentSessionId,
      clearLastError: true,
      activeView: "threads",
      emitState: false,
      persistState: false,
      publishSelectedTranscript: false,
    });

    let deliveryStatus: CreatedChildThreadResult["deliveryStatus"];
    try {
      deliveryStatus = await launchInitialChildPrompt(store, childRef, prompt);
    } catch (error) {
      markInitialPromptDeliveryFailed(store, child.id, error);
      await store.persistUiState();
      throw error;
    }

    return {
      child:
        store.state.orchestrationChildren.find((entry) => entry.id === child.id) ??
        childWithEvidence,
      deliveryStatus,
    };
  } finally {
    if (pendingKey) {
      pendingCreateChildThreadToolCalls.delete(pendingKey);
    }
  }
}

async function handleCreateChildThreadToolResult(
  store: AppStoreInternals,
  event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
): Promise<boolean> {
  if (!event.success) {
    return false;
  }

  const tool = toolCallForFinishedEvent(store, event);
  if (!tool || tool.toolName !== createChildThreadToolName) {
    return false;
  }

  const finalOutput = finalThreadToolProjectionFromOutput(event.output);
  if (finalOutput) {
    updateThreadToolOutput(store, event, finalOutput);
    return true;
  }

  const prompt = createChildThreadPromptFromToolOutput(event.output);
  if (!prompt) {
    return false;
  }

  let deliveryStatus: CreatedChildThreadResult["deliveryStatus"];
  try {
    const result = await createChildThreadRecord(store, {
      parentWorkspaceId: event.sessionRef.workspaceId,
      parentSessionId: event.sessionRef.sessionId,
      prompt,
      sourceToolCallId: event.callId,
    });
    deliveryStatus = result.deliveryStatus;
  } catch (error) {
    const message = errorMessage(error);
    await store.withError(error);
    updateThreadToolOutput(
      store,
      event,
      projectionFromToolResult(createChildThreadErrorResult(prompt, message)),
    );
    return true;
  }

  const child = childForToolCall(store, {
    parentWorkspaceId: event.sessionRef.workspaceId,
    parentSessionId: event.sessionRef.sessionId,
    sourceToolCallId: event.callId,
  });
  if (!child) {
    return false;
  }

  updateCreateChildThreadToolOutput(store, event, prompt, child, deliveryStatus);
  return true;
}

export async function handleOrchestrationThreadToolResult(
  store: AppStoreInternals,
  event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
): Promise<boolean> {
  if (!event.success) {
    return false;
  }

  const tool = toolCallForFinishedEvent(store, event);
  if (!tool) {
    return false;
  }

  if (tool.toolName === createChildThreadToolName) {
    return handleCreateChildThreadToolResult(store, event);
  }

  if (tool.toolName === listThreadsToolName && listThreadsRequestedFromToolOutput(event.output)) {
    updateListThreadsToolOutput(store, event);
    refreshParentOrchestrationEvidence(store, event.sessionRef);
    return true;
  }

  if (tool.toolName === readThreadToolName) {
    await updateReadThreadToolOutput(store, event);
    refreshParentOrchestrationEvidence(store, event.sessionRef);
    return true;
  }

  if (tool.toolName === sendMessageToThreadToolName) {
    await updateSendMessageToThreadToolOutput(store, event);
    refreshParentOrchestrationEvidence(store, event.sessionRef);
    return true;
  }

  return false;
}

export async function sendChildThreadFollowUp(
  store: AppStoreInternals,
  input: SendChildThreadFollowUpInput,
): Promise<DesktopAppState> {
  await store.initialize();
  const text = input.text.trim();
  if (!text) {
    return store.withError("Child thread follow-up cannot be empty.");
  }

  const child = store.state.orchestrationChildren.find((entry) => entry.id === input.childThreadId);
  if (!child) {
    return store.withError("Unknown child thread.");
  }
  if (!child.childSessionId) {
    return store.withError("Legacy child thread records are read-only.");
  }

  const childRef = childSessionRef(child);
  if (!store.sessionFromState(childRef)) {
    return store.withError("Child thread session is no longer available.");
  }

  await submitComposerToSession(store, childRef, text, [], {
    deliverAs: "followUp",
    allowCommands: false,
  });
  updateChildSupervisionLoop(
    store,
    child.id,
    "continue",
    "Follow-up sent; monitoring child progress.",
  );
  await store.persistUiState();
  return store.emit();
}

export async function setChildSupervisionLoopGate(
  store: AppStoreInternals,
  input: SetChildSupervisionLoopInput,
): Promise<DesktopAppState> {
  await store.initialize();
  const child = store.state.orchestrationChildren.find((entry) => entry.id === input.childThreadId);
  if (!child) {
    return store.withError("Unknown child thread.");
  }

  // Stopping supervision must also stop the child agent: otherwise the loop
  // stops watching but the child keeps running (and spending) unsupervised.
  if (input.gate === "stop") {
    await cancelChildRun(store, child);
  }

  updateChildSupervisionLoop(
    store,
    input.childThreadId,
    input.gate,
    input.gate === "stop"
      ? "Parent stopped app-owned supervision for this child."
      : "Parent continued app-owned supervision.",
  );
  await store.persistUiState();
  return store.emit();
}

async function cancelChildRun(
  store: AppStoreInternals,
  child: OrchestrationChildThread,
): Promise<void> {
  if (!child.childSessionId) {
    return;
  }
  await store.driver.cancelCurrentRun(childSessionRef(child)).catch(() => undefined);
}

/**
 * Cancel the active runs of every child owned by a parent session. Call this
 * when the parent's own run is cancelled so children don't keep running
 * unsupervised. Best-effort per child.
 */
export async function cancelChildRunsForParent(
  store: AppStoreInternals,
  parentRef: SessionRef,
): Promise<void> {
  const children = store.state.orchestrationChildren.filter(
    (child) =>
      child.parentWorkspaceId === parentRef.workspaceId &&
      child.parentSessionId === parentRef.sessionId,
  );
  await Promise.all(children.map((child) => cancelChildRun(store, child)));
}

export async function createChildThreadToolResult(
  store: AppStoreInternals,
  parentRef: SessionRef,
  input: { readonly prompt: string; readonly toolCallId: string },
): Promise<AgentToolResult<CreateChildThreadToolDetails>> {
  const { child, deliveryStatus } = await createChildThreadRecord(store, {
    parentWorkspaceId: parentRef.workspaceId,
    parentSessionId: parentRef.sessionId,
    prompt: input.prompt,
    sourceToolCallId: input.toolCallId,
  });
  const details: CreateChildThreadToolDetails = {
    action: createChildThreadAction,
    prompt: input.prompt.trim(),
    childThreadId: child.id,
    childWorkspaceId: child.childWorkspaceId,
    childSessionId: child.childSessionId,
    title: child.title,
    deliveryStatus,
  };

  return {
    content: [{ type: "text", text: formatCreateChildThreadResult(details) }],
    details,
  };
}

function updateListThreadsToolOutput(
  store: AppStoreInternals,
  event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
): void {
  updateThreadToolOutput(
    store,
    event,
    finalThreadToolProjectionFromOutput(event.output) ??
      projectionFromToolResult(listThreadsToolResult(store, event.sessionRef)),
  );
}

async function updateReadThreadToolOutput(
  store: AppStoreInternals,
  event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
): Promise<void> {
  const finalOutput = finalThreadToolProjectionFromOutput(event.output);
  if (finalOutput) {
    updateThreadToolOutput(store, event, finalOutput);
    return;
  }

  const threadId = readThreadIdFromToolOutput(event.output);
  if (!threadId) {
    updateThreadToolOutput(
      store,
      event,
      projectionFromToolResult(readThreadErrorResult("", "read_thread requires a thread_id.")),
    );
    return;
  }

  updateThreadToolOutput(
    store,
    event,
    projectionFromToolResult(await readThreadToolResult(store, event.sessionRef, threadId)),
  );
}

async function updateSendMessageToThreadToolOutput(
  store: AppStoreInternals,
  event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
): Promise<void> {
  const finalOutput = finalThreadToolProjectionFromOutput(event.output);
  if (finalOutput) {
    updateThreadToolOutput(store, event, finalOutput);
    return;
  }

  const request = sendMessageToThreadFromToolOutput(event.output);
  if (!request) {
    updateThreadToolOutput(
      store,
      event,
      projectionFromToolResult(
        sendMessageToThreadErrorResult(
          "",
          "",
          "send_message_to_thread requires thread_id and message.",
        ),
      ),
    );
    return;
  }

  updateThreadToolOutput(
    store,
    event,
    projectionFromToolResult(await sendMessageToThreadToolResult(store, event.sessionRef, request)),
  );
}

export function listThreadsToolResult(
  store: AppStoreInternals,
  parentRef: SessionRef,
): AgentToolResult<ListThreadsToolDetails> {
  store.state = {
    ...store.state,
    orchestrationChildren: projectOrchestrationChildren(store),
  };
  const threads = listThreadsForContext(store, parentRef);
  return {
    content: [{ type: "text", text: formatThreadList(threads) }],
    details: {
      action: listThreadsAction,
      threads,
    },
  };
}

export async function readThreadToolResult(
  store: AppStoreInternals,
  parentRef: SessionRef,
  threadId: string,
): Promise<AgentToolResult<ReadThreadToolDetails>> {
  const target = resolveThreadTarget(store, parentRef, threadId);
  if (!target) {
    return readThreadErrorResult(threadId, `Unknown thread: ${threadId}`);
  }

  await store.ensureSessionReady(target.sessionRef);
  const transcript = store.sessionState.transcriptCache.get(sessionKey(target.sessionRef)) ?? [];
  const session = store.sessionFromState(target.sessionRef);
  const messages = toThreadReadMessages(transcript);
  const title = session?.title ?? target.child?.title ?? target.sessionRef.sessionId;
  const status = target.child?.status ?? session?.status ?? "unknown";
  const details: ReadThreadToolDetails = {
    action: readThreadAction,
    threadId,
    workspaceId: target.sessionRef.workspaceId,
    sessionId: target.sessionRef.sessionId,
    title,
    status,
    ...(target.child
      ? {
          childThreadId: target.child.id,
          goal: target.child.goal,
        }
      : {}),
    messages,
  };

  return {
    content: [
      { type: "text", text: formatThreadReadResult({ ...details, title, status, messages }) },
    ],
    details,
  };
}

export async function sendMessageToThreadToolResult(
  store: AppStoreInternals,
  parentRef: SessionRef,
  input: { readonly threadId: string; readonly message: string },
): Promise<AgentToolResult<SendMessageToThreadToolDetails>> {
  const target = resolveThreadTarget(store, parentRef, input.threadId);
  if (!target) {
    return sendMessageToThreadErrorResult(
      input.threadId,
      input.message,
      `Unknown thread: ${input.threadId}`,
    );
  }

  await submitComposerToSession(store, target.sessionRef, input.message, [], {
    deliverAs: "followUp",
    allowCommands: false,
  });
  if (target.child) {
    updateChildSupervisionLoop(
      store,
      target.child.id,
      "continue",
      "Follow-up sent; monitoring child progress.",
    );
    await store.persistUiState();
  }

  const queuedMessages = store.getQueuedComposerMessages(target.sessionRef);
  const status = queuedMessages.length > 0 ? "queued" : "sent";
  const details: SendMessageToThreadToolDetails = {
    action: sendMessageToThreadAction,
    threadId: input.threadId,
    workspaceId: target.sessionRef.workspaceId,
    sessionId: target.sessionRef.sessionId,
    status,
    queuedMessageCount: queuedMessages.length,
    message: input.message,
  };

  return {
    content: [{ type: "text", text: formatSendMessageToThreadResult(details) }],
    details,
  };
}

export function projectOrchestrationChildren(
  store: AppStoreInternals,
  children: readonly OrchestrationChildThread[] = store.state.orchestrationChildren,
): readonly OrchestrationChildThread[] {
  const now = new Date().toISOString();
  const parentEvidenceByChild = parentEvidenceIndex(store, children);
  return children.map((child) =>
    projectOrchestrationChild(store, child, now, parentEvidenceByChild.get(child.id) ?? []),
  );
}

export function projectOrchestrationChildrenForSession(
  store: AppStoreInternals,
  sessionRef: SessionRef,
): readonly OrchestrationChildThread[] {
  const now = new Date().toISOString();
  const parentEvidenceByChild = parentEvidenceIndex(store, store.state.orchestrationChildren);
  return store.state.orchestrationChildren.map((child) =>
    child.childWorkspaceId === sessionRef.workspaceId &&
    child.childSessionId === sessionRef.sessionId
      ? projectOrchestrationChild(store, child, now, parentEvidenceByChild.get(child.id) ?? [])
      : child,
  );
}

export function reconcileDueSupervisionLoops(
  store: AppStoreInternals,
  now: Date = new Date(),
): { readonly changed: boolean; readonly nextRunAt?: string } {
  let shouldPublish = false;
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const parentEvidenceByChild = parentEvidenceIndex(store, store.state.orchestrationChildren);
  const children = store.state.orchestrationChildren.map((child) => {
    const beforeKey = supervisionPublishKey(child);
    const projectedChild = projectOrchestrationChild(
      store,
      child,
      nowIso,
      parentEvidenceByChild.get(child.id) ?? [],
    );
    if (supervisionPublishKey(projectedChild) !== beforeKey) {
      shouldPublish = true;
    }
    if (!projectedChild.childSessionId || projectedChild.supervisionLoop?.status === "stopped") {
      return projectedChild;
    }
    const loop = projectSupervisionLoop(
      projectedChild.supervisionLoop,
      projectedChild.status,
      nowIso,
    );
    if (!loop.nextRunAt || Date.parse(loop.nextRunAt) > nowMs) {
      return loop === projectedChild.supervisionLoop
        ? projectedChild
        : { ...projectedChild, supervisionLoop: loop };
    }
    const advancedChild = {
      ...projectedChild,
      supervisionLoop: advanceSupervisionLoop(loop, projectedChild.status, now),
    };
    if (supervisionPublishKey(advancedChild) !== beforeKey) {
      shouldPublish = true;
    }
    return advancedChild;
  });

  store.state = {
    ...store.state,
    orchestrationChildren: children,
  };

  return {
    changed: shouldPublish,
    nextRunAt: nextSupervisionRunAt(children),
  };
}

export async function hydrateOrchestrationChildren(store: AppStoreInternals): Promise<void> {
  await hydrateVisibleOrchestrationChildren(store);
}

export async function hydrateVisibleOrchestrationChildren(store: AppStoreInternals): Promise<void> {
  const visibleChildren = store.state.orchestrationChildren.filter(
    (child) =>
      child.parentWorkspaceId === store.state.selectedWorkspaceId &&
      child.parentSessionId === store.state.selectedSessionId,
  );
  const seen = new Set<string>();
  const hydrationTasks: Promise<unknown>[] = [];
  for (const child of visibleChildren) {
    if (!child.childSessionId) {
      continue;
    }
    const childRef = childSessionRef(child);
    const key = sessionKey(childRef);
    if (
      seen.has(key) ||
      !store.sessionFromState(childRef) ||
      store.sessionState.loadedTranscriptKeys.has(key)
    ) {
      continue;
    }
    seen.add(key);
    hydrationTasks.push(
      store.ensureSessionReady(childRef).catch((error) => {
        store.sessionState.sessionErrorsBySession.set(key, errorMessage(error));
      }),
    );
  }
  await Promise.all(hydrationTasks);
}

export function hasOrchestrationChildSession(
  children: readonly OrchestrationChildThread[],
  sessionRef: SessionRef,
): boolean {
  return children.some(
    (child) =>
      Boolean(child.childSessionId) &&
      child.childWorkspaceId === sessionRef.workspaceId &&
      child.childSessionId === sessionRef.sessionId,
  );
}

export function hasOrchestrationParentSession(
  children: readonly OrchestrationChildThread[],
  sessionRef: SessionRef,
): boolean {
  return children.some(
    (child) =>
      child.parentWorkspaceId === sessionRef.workspaceId &&
      child.parentSessionId === sessionRef.sessionId,
  );
}

export function toPersistedOrchestrationChildren(
  children: readonly OrchestrationChildThread[],
): readonly OrchestrationChildThread[] | undefined {
  if (children.length === 0) {
    return undefined;
  }
  return children.map((child) => ({
    ...child,
    latestTranscript: child.childSessionId ? child.goal : child.latestTranscript,
    transcript: child.childSessionId ? [] : child.transcript,
    evidence: capEvidenceRecords(child.evidence),
  }));
}

export function nextSupervisionRunAt(
  children: readonly OrchestrationChildThread[],
): string | undefined {
  return children
    .flatMap((child) =>
      child.supervisionLoop?.status !== "stopped" &&
      child.supervisionLoop?.nextRunAt &&
      Number.isFinite(Date.parse(child.supervisionLoop.nextRunAt))
        ? [child.supervisionLoop.nextRunAt]
        : [],
    )
    .sort()[0];
}

function childSessionRef(child: OrchestrationChildThread): SessionRef {
  return {
    workspaceId: child.childWorkspaceId,
    sessionId: child.childSessionId,
  };
}

async function launchInitialChildPrompt(
  store: AppStoreInternals,
  childRef: SessionRef,
  prompt: string,
): Promise<CreatedChildThreadResult["deliveryStatus"]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let runningTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      finish(
        new Error(
          `Child thread did not acknowledge its initial prompt within ${CHILD_START_TIMEOUT_MS}ms.`,
        ),
      );
    }, CHILD_START_TIMEOUT_MS);
    const unsubscribe = store.subscribeToSessionEvents((event) => {
      if (sessionKey(event.sessionRef) !== sessionKey(childRef)) {
        return;
      }
      if (event.type === "runFailed") {
        finish(new Error(`Failed to start child thread: ${event.error.message}`));
        return;
      }
      if (event.type === "sessionClosed" && event.reason === "failed") {
        finish(new Error("Failed to start child thread: the child session closed."));
        return;
      }
      acknowledgeCurrentState();
    });

    function cleanup(): void {
      clearTimeout(timeout);
      if (runningTimer) {
        clearTimeout(runningTimer);
      }
      unsubscribe();
    }

    function finish(result: CreatedChildThreadResult["deliveryStatus"] | Error): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    }

    function acknowledgeCurrentState(): void {
      try {
        const status = initialPromptDeliveryStatus(store, childRef, prompt);
        if (status === "responded") {
          finish(status);
        } else if (status === "running" && !runningTimer) {
          // The driver publishes `running` immediately before session.prompt().
          // Race submission completion and failure events against a bounded grace
          // so deterministic auth/config failures win without awaiting the turn.
          runningTimer = setTimeout(() => finish("running"), CHILD_RUNNING_FAILURE_GRACE_MS);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    }

    const submission = submitComposerToSession(store, childRef, prompt, [], {
      deliverAs: "followUp",
      allowCommands: false,
    });
    void submission.then(
      () => {
        if (settled) {
          return;
        }
        acknowledgeCurrentState();
        if (!settled && !runningTimer) {
          finish(
            new Error(
              "Child thread prompt submission completed without starting a run or producing a response.",
            ),
          );
        }
      },
      (error) => finish(error instanceof Error ? error : new Error(errorMessage(error))),
    );
  });
}

function requireInitialPromptRun(
  store: AppStoreInternals,
  childRef: SessionRef,
  prompt: string,
): CreatedChildThreadResult["deliveryStatus"] {
  const status = initialPromptDeliveryStatus(store, childRef, prompt);
  if (status) {
    return status;
  }
  throw new Error(
    "Child thread has no evidence that its initial prompt started a run or produced a response.",
  );
}

function initialPromptDeliveryStatus(
  store: AppStoreInternals,
  childRef: SessionRef,
  prompt: string,
): CreatedChildThreadResult["deliveryStatus"] | undefined {
  const key = sessionKey(childRef);
  const sessionError = store.sessionState.sessionErrorsBySession.get(key);
  if (sessionError) {
    throw new Error(`Failed to start child thread: ${sessionError}`);
  }

  const session = store.sessionFromState(childRef);
  if (session?.status === "failed") {
    throw new Error(
      `Failed to start child thread: ${session.preview || "the child session failed."}`,
    );
  }

  const transcript = store.sessionState.transcriptCache.get(key) ?? [];
  const promptIndex = transcript.findIndex(
    (item) => item.kind === "message" && item.role === "user" && item.text === prompt,
  );
  if (promptIndex < 0) {
    return undefined;
  }
  if (transcript.slice(promptIndex + 1).some(isWorkerResponse)) {
    return "responded";
  }
  return session?.status === "running" ? "running" : undefined;
}

function isWorkerResponse(item: TranscriptMessage): boolean {
  return item.kind === "tool" || (item.kind === "message" && item.role === "assistant");
}

function markInitialPromptDeliveryFailed(
  store: AppStoreInternals,
  childThreadId: string,
  error: unknown,
): void {
  const now = new Date().toISOString();
  const message = errorMessage(error);
  store.state = {
    ...store.state,
    orchestrationChildren: store.state.orchestrationChildren.map((child) =>
      child.id === childThreadId
        ? {
            ...child,
            status: "failed",
            latestTranscript: message,
            evidence: mergeEvidenceRecords(child.evidence, [
              {
                id: evidenceId("delivery-failed", child.sourceToolCallId ?? child.childSessionId),
                childThreadId: child.id,
                kind: "blocker",
                source: "blocker",
                status: "failed",
                title: "Initial prompt delivery failed",
                detail: message,
                parentSessionId: child.parentSessionId,
                childSessionId: child.childSessionId,
                createdAt: now,
              },
            ]),
            updatedAt: now,
          }
        : child,
    ),
  };
}

function projectOrchestrationChild(
  store: AppStoreInternals,
  child: OrchestrationChildThread,
  nowIso: string,
  parentEvidence: readonly OrchestrationEvidenceRecord[],
): OrchestrationChildThread {
  if (!child.childSessionId) {
    return child;
  }
  const childRef = childSessionRef(child);
  const key = sessionKey(childRef);
  const session = store.sessionFromState(childRef);
  const rawTranscript = recentTranscriptItems(store.sessionState.transcriptCache.get(key) ?? []);
  const transcript = toChildTranscript(rawTranscript, MAX_CHILD_TRANSCRIPT_MESSAGES);
  const latestTranscript = session?.preview || previewFromTranscript(rawTranscript) || child.goal;
  const updatedAt = latestSessionActivityAt(session?.updatedAt ?? child.updatedAt, rawTranscript);
  const status = session ? toOrchestrationStatus(session.status, childRef, store) : child.status;

  return {
    ...child,
    title: session?.title || child.title,
    status,
    latestTranscript,
    transcript,
    evidence: mergeEvidenceRecords(child.evidence, [
      ...evidenceFromChildTranscript(child, rawTranscript),
      ...parentEvidence,
      ...blockerEvidenceFromChildStatus(child, status, updatedAt),
    ]),
    supervisionLoop: projectSupervisionLoop(child.supervisionLoop, status, nowIso),
    updatedAt,
  };
}

function createSupervisionLoop(
  status: OrchestrationChildThreadStatus,
  nowIso: string,
): OrchestrationSupervisionLoop {
  const intervalMs = supervisionIntervalMs();
  return {
    id: randomUUID(),
    status: "monitoring",
    gate: "continue",
    intervalMs,
    iterationCount: 0,
    lastCheckedAt: nowIso,
    nextRunAt: nextIso(nowIso, intervalMs),
    reason: monitoringReason(status),
    lastChildStatus: status,
  };
}

function projectSupervisionLoop(
  loop: OrchestrationSupervisionLoop | undefined,
  status: OrchestrationChildThreadStatus,
  nowIso: string,
): OrchestrationSupervisionLoop {
  if (!loop) {
    return createSupervisionLoop(status, nowIso);
  }
  if (loop.status === "stopped" || loop.gate === "stop") {
    return loop;
  }
  if (status === "complete" || status === "failed") {
    if (loop.gate === "wake" && loop.lastChildStatus === status) {
      return loop;
    }
    return {
      ...loop,
      status: "attention",
      gate: "wake",
      lastCheckedAt: nowIso,
      nextRunAt: undefined,
      reason:
        status === "failed"
          ? "Child failed; parent review is needed."
          : "Child completed; parent review is ready.",
      lastChildStatus: status,
    };
  }
  if (loop.gate !== "continue" || loop.status !== "monitoring" || loop.lastChildStatus !== status) {
    return {
      ...loop,
      status: "monitoring",
      gate: "continue",
      lastCheckedAt: nowIso,
      nextRunAt: loop.nextRunAt ?? nextIso(nowIso, loop.intervalMs),
      reason: monitoringReason(status),
      lastChildStatus: status,
    };
  }
  return loop;
}

function advanceSupervisionLoop(
  loop: OrchestrationSupervisionLoop,
  status: OrchestrationChildThreadStatus,
  now: Date,
): OrchestrationSupervisionLoop {
  const nowIso = now.toISOString();
  const projected = projectSupervisionLoop(loop, status, nowIso);
  if (projected.gate === "wake" || projected.status === "stopped") {
    return {
      ...projected,
      iterationCount: loop.iterationCount + 1,
    };
  }
  return {
    ...projected,
    iterationCount: loop.iterationCount + 1,
    lastCheckedAt: nowIso,
    nextRunAt: nextIso(nowIso, projected.intervalMs),
    reason: monitoringReason(status),
    lastChildStatus: status,
  };
}

function monitoringReason(status: OrchestrationChildThreadStatus): string {
  if (status === "waiting") {
    return "Child has queued follow-up; waiting for the run to continue.";
  }
  if (status === "queued") {
    return "Child queued; waiting for the run to start.";
  }
  return "Monitoring child thread.";
}

function supervisionPublishKey(child: OrchestrationChildThread): string {
  const loop = child.supervisionLoop;
  return [
    child.id,
    child.status,
    loop?.status ?? "",
    loop?.gate ?? "",
    loop?.reason ?? "",
    loop?.lastChildStatus ?? "",
    loop?.stoppedAt ?? "",
  ].join("\0");
}

function updateChildSupervisionLoop(
  store: AppStoreInternals,
  childThreadId: string,
  gate: SetChildSupervisionLoopInput["gate"],
  reason: string,
): void {
  const nowIso = new Date().toISOString();
  store.state = {
    ...store.state,
    orchestrationChildren: store.state.orchestrationChildren.map((child) => {
      if (child.id !== childThreadId) {
        return child;
      }
      const existing = child.supervisionLoop ?? createSupervisionLoop(child.status, nowIso);
      const intervalMs = existing.intervalMs || supervisionIntervalMs();
      const status: OrchestrationSupervisionStatus = gate === "stop" ? "stopped" : "monitoring";
      return {
        ...child,
        supervisionLoop: {
          ...existing,
          status,
          gate,
          intervalMs,
          lastCheckedAt: nowIso,
          nextRunAt: gate === "stop" ? undefined : nextIso(nowIso, intervalMs),
          reason,
          lastChildStatus: child.status,
          ...(gate === "stop" ? { stoppedAt: nowIso } : { stoppedAt: undefined }),
        },
      };
    }),
  };
}

function supervisionIntervalMs(): number {
  const configured = Number(process.env.PI_APP_ORCHESTRATION_SUPERVISION_INTERVAL_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_SUPERVISION_INTERVAL_MS;
  }
  return Math.max(MIN_SUPERVISION_INTERVAL_MS, Math.floor(configured));
}

function nextIso(fromIso: string, intervalMs: number): string {
  return new Date(Date.parse(fromIso) + intervalMs).toISOString();
}

function updateCreateChildThreadToolOutput(
  store: AppStoreInternals,
  event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
  prompt: string,
  child: OrchestrationChildThread,
  deliveryStatus: CreatedChildThreadResult["deliveryStatus"],
): void {
  updateThreadToolOutput(store, event, {
    detail: `Created child thread: ${child.title}`,
    text: `Created child thread: ${child.title}`,
    details: {
      action: createChildThreadAction,
      prompt,
      childThreadId: child.id,
      childWorkspaceId: child.childWorkspaceId,
      childSessionId: child.childSessionId,
      title: child.title,
      deliveryStatus,
    },
  });
}

function updateThreadToolOutput(
  store: AppStoreInternals,
  event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
  output: {
    readonly detail: string;
    readonly text: string;
    readonly details: Readonly<Record<string, unknown>>;
    readonly status?: TimelineToolCall["status"];
  },
): void {
  const key = sessionKey(event.sessionRef);
  const transcript = [...(store.sessionState.transcriptCache.get(key) ?? [])];
  const index = transcript.findIndex(
    (item) => item.kind === "tool" && item.callId === event.callId,
  );
  const item = transcript[index];
  if (!item || !isTimelineToolCall(item)) {
    return;
  }
  transcript[index] = {
    ...item,
    status: output.status ?? item.status,
    detail: output.detail,
    output: {
      content: [
        {
          type: "text",
          text: output.text,
        },
      ],
      details: output.details,
    },
  };
  store.sessionState.transcriptCache.set(key, transcript);
}

function refreshParentOrchestrationEvidence(store: AppStoreInternals, parentRef: SessionRef): void {
  if (
    !store.state.orchestrationChildren.some(
      (child) =>
        child.parentWorkspaceId === parentRef.workspaceId &&
        child.parentSessionId === parentRef.sessionId,
    )
  ) {
    return;
  }
  store.state = {
    ...store.state,
    orchestrationChildren: projectOrchestrationChildren(store),
  };
}

function toolCallForFinishedEvent(
  store: AppStoreInternals,
  event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
): TimelineToolCall | undefined {
  const transcript = store.sessionState.transcriptCache.get(sessionKey(event.sessionRef));
  return transcript?.find(
    (item): item is TimelineToolCall => isTimelineToolCall(item) && item.callId === event.callId,
  );
}

type ThreadListEntry = OrchestrationThreadListEntry;

interface ResolvedThreadTarget {
  readonly sessionRef: SessionRef;
  readonly child?: OrchestrationChildThread;
}

function createChildThreadErrorResult(
  prompt: string,
  error: string,
): AgentToolResult<CreateChildThreadToolDetails> {
  return {
    content: [{ type: "text", text: error }],
    details: {
      action: createChildThreadAction,
      prompt,
      error,
    },
  };
}

function readThreadErrorResult(
  threadId: string,
  error: string,
): AgentToolResult<ReadThreadToolDetails> {
  return {
    content: [{ type: "text", text: error }],
    details: {
      action: readThreadAction,
      threadId,
      error,
    },
  };
}

function sendMessageToThreadErrorResult(
  threadId: string,
  message: string,
  error: string,
): AgentToolResult<SendMessageToThreadToolDetails> {
  return {
    content: [{ type: "text", text: error }],
    details: {
      action: sendMessageToThreadAction,
      threadId,
      message,
      error,
    },
  };
}

function projectionFromToolResult(
  result: AgentToolResult<
    | CreateChildThreadToolDetails
    | ListThreadsToolDetails
    | ReadThreadToolDetails
    | SendMessageToThreadToolDetails
  >,
): {
  readonly detail: string;
  readonly text: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly status?: TimelineToolCall["status"];
} {
  const details = result.details as unknown as Readonly<Record<string, unknown>>;
  return {
    detail: detailFromThreadToolDetails(details),
    text: textFromAgentToolResult(result),
    details,
    ...(typeof details.error === "string" ? { status: "error" as const } : {}),
  };
}

function finalThreadToolProjectionFromOutput(output: unknown):
  | {
      readonly detail: string;
      readonly text: string;
      readonly details: Readonly<Record<string, unknown>>;
      readonly status?: TimelineToolCall["status"];
    }
  | undefined {
  if (!isRecord(output) || !isRecord(output.details) || !isFinalThreadToolDetails(output.details)) {
    return undefined;
  }
  return {
    detail: detailFromThreadToolDetails(output.details),
    text: textFromToolOutput(output),
    details: output.details,
    ...(typeof output.details.error === "string" ? { status: "error" as const } : {}),
  };
}

function isFinalThreadToolDetails(details: Record<string, unknown>): boolean {
  if (typeof details.error === "string") {
    return true;
  }
  if (details.action === listThreadsAction) {
    return Array.isArray(details.threads);
  }
  if (details.action === createChildThreadAction) {
    return typeof details.childThreadId === "string";
  }
  if (details.action === readThreadAction) {
    return Array.isArray(details.messages);
  }
  if (details.action === sendMessageToThreadAction) {
    return details.status === "queued" || details.status === "sent";
  }
  return false;
}

function detailFromThreadToolDetails(details: Readonly<Record<string, unknown>>): string {
  if (typeof details.error === "string") {
    return details.error;
  }
  if (details.action === listThreadsAction) {
    const count = Array.isArray(details.threads) ? details.threads.length : 0;
    return `Listed ${count} thread${count === 1 ? "" : "s"}`;
  }
  if (details.action === createChildThreadAction) {
    const title =
      typeof details.title === "string"
        ? details.title
        : typeof details.prompt === "string"
          ? details.prompt
          : "unknown";
    return `Created child thread: ${title}`;
  }
  if (details.action === readThreadAction) {
    const title =
      typeof details.title === "string"
        ? details.title
        : typeof details.threadId === "string"
          ? details.threadId
          : "unknown";
    return `Read thread: ${title}`;
  }
  if (details.action === sendMessageToThreadAction) {
    const verb = details.status === "queued" ? "Queued" : "Sent";
    return `${verb} message to thread: ${typeof details.threadId === "string" ? details.threadId : "unknown"}`;
  }
  return "Thread tool result";
}

function textFromAgentToolResult(result: AgentToolResult<unknown>): string {
  return result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function textFromToolOutput(output: { readonly content?: unknown }): string {
  if (!Array.isArray(output.content)) {
    return "";
  }
  return output.content
    .map((item) =>
      isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : "",
    )
    .filter(Boolean)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function listThreadsForContext(
  store: AppStoreInternals,
  parentRef: SessionRef,
): readonly ThreadListEntry[] {
  const entries = new Map<string, ThreadListEntry>();
  const parentChildren = store.state.orchestrationChildren.filter(
    (child) =>
      child.parentWorkspaceId === parentRef.workspaceId &&
      child.parentSessionId === parentRef.sessionId,
  );
  const childSessionKeys = new Map(
    parentChildren.map((child) => [sessionKey(childSessionRef(child)), child] as const),
  );

  for (const workspace of store.state.workspaces) {
    if (
      workspace.id !== parentRef.workspaceId &&
      !parentChildren.some((child) => child.childWorkspaceId === workspace.id)
    ) {
      continue;
    }
    for (const session of workspace.sessions) {
      if (session.archivedAt) {
        continue;
      }
      const key = sessionKey({ workspaceId: workspace.id, sessionId: session.id });
      const child = childSessionKeys.get(key);
      entries.set(key, {
        threadId: child?.id ?? session.id,
        workspaceId: workspace.id,
        sessionId: session.id,
        title: child?.title ?? session.title,
        status: child?.status ?? session.status,
        ...(child ? threadListSupervisionFields(child) : {}),
        relationship: child
          ? "child"
          : session.id === parentRef.sessionId && workspace.id === parentRef.workspaceId
            ? "current"
            : "workspace",
        updatedAt: child?.updatedAt ?? session.updatedAt,
        preview: child?.latestTranscript ?? session.preview,
        ...(child ? { childThreadId: child.id } : {}),
      });
    }
  }

  for (const child of parentChildren) {
    const key = sessionKey(childSessionRef(child));
    if (entries.has(key)) {
      continue;
    }
    entries.set(key, {
      threadId: child.id,
      workspaceId: child.childWorkspaceId,
      sessionId: child.childSessionId,
      title: child.title,
      status: child.status,
      ...threadListSupervisionFields(child),
      relationship: "child",
      updatedAt: child.updatedAt,
      preview: child.latestTranscript,
      childThreadId: child.id,
    });
  }

  return [...entries.values()].sort((left, right) => {
    const rank = relationshipRank(left.relationship) - relationshipRank(right.relationship);
    if (rank !== 0) {
      return rank;
    }
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt.localeCompare(left.updatedAt);
    }
    return left.title.localeCompare(right.title);
  });
}

function relationshipRank(relationship: ThreadListEntry["relationship"]): number {
  if (relationship === "current") {
    return 0;
  }
  if (relationship === "child") {
    return 1;
  }
  return 2;
}

function threadListSupervisionFields(
  child: OrchestrationChildThread,
): Pick<ThreadListEntry, "supervisionGate" | "supervisionReason" | "nextSupervisionRunAt"> {
  if (!child.supervisionLoop) {
    return {};
  }
  return {
    supervisionGate: child.supervisionLoop.gate,
    supervisionReason: child.supervisionLoop.reason,
    ...(child.supervisionLoop.nextRunAt
      ? { nextSupervisionRunAt: child.supervisionLoop.nextRunAt }
      : {}),
  };
}

function resolveThreadTarget(
  store: AppStoreInternals,
  parentRef: SessionRef,
  threadId: string,
): ResolvedThreadTarget | undefined {
  const normalized = threadId.trim();
  if (!normalized) {
    return undefined;
  }

  const visibleThread = listThreadsForContext(store, parentRef).find(
    (thread) =>
      thread.threadId === normalized ||
      thread.sessionId === normalized ||
      thread.childThreadId === normalized ||
      `${thread.workspaceId}:${thread.sessionId}` === normalized,
  );
  if (!visibleThread) {
    return undefined;
  }

  const child = visibleThread.childThreadId
    ? store.state.orchestrationChildren.find((entry) => entry.id === visibleThread.childThreadId)
    : undefined;
  return {
    sessionRef: {
      workspaceId: visibleThread.workspaceId,
      sessionId: visibleThread.sessionId,
    },
    ...(child ? { child } : {}),
  };
}

function formatThreadList(threads: readonly ThreadListEntry[]): string {
  if (threads.length === 0) {
    return "No visible threads.";
  }
  return [
    "Visible threads:",
    ...threads.map(
      (thread) =>
        `- ${thread.threadId} (${thread.relationship}, ${thread.status}): ${thread.title}` +
        (thread.supervisionGate
          ? ` [gate=${thread.supervisionGate}: ${thread.supervisionReason ?? "monitoring"}]`
          : "") +
        (thread.preview ? ` - ${thread.preview}` : ""),
    ),
  ].join("\n");
}

function formatThreadReadResult(result: {
  readonly threadId: string;
  readonly title: string;
  readonly status: string;
  readonly goal?: string;
  readonly messages: readonly OrchestrationChildTranscriptMessage[];
}): string {
  const lines = [
    `Thread ${result.threadId}: ${result.title}`,
    `Status: ${result.status}`,
    ...(result.goal ? [`Goal: ${result.goal}`] : []),
    "Transcript:",
  ];
  if (result.messages.length === 0) {
    lines.push("- No transcript messages loaded.");
  } else {
    lines.push(...result.messages.map((message) => `- ${message.role}: ${message.text}`));
  }
  return lines.join("\n");
}

function formatCreateChildThreadResult(result: CreateChildThreadToolDetails): string {
  return (
    `Created child thread: ${result.title ?? result.prompt}\n` +
    `childThreadId: ${result.childThreadId ?? ""}\n` +
    `childWorkspaceId: ${result.childWorkspaceId ?? ""}\n` +
    `childSessionId: ${result.childSessionId ?? ""}` +
    (result.deliveryStatus ? `\ninitialPrompt: ${result.deliveryStatus}` : "")
  );
}

function formatSendMessageToThreadResult(result: SendMessageToThreadToolDetails): string {
  const verb = result.status === "queued" ? "Queued" : "Sent";
  return (
    `${verb} message to thread ${result.threadId}.` +
    (result.queuedMessageCount && result.queuedMessageCount > 0
      ? ` Pending messages: ${result.queuedMessageCount}.`
      : "")
  );
}

function toThreadReadMessages(
  transcript: readonly TranscriptMessage[],
): readonly OrchestrationChildTranscriptMessage[] {
  return toChildTranscript(transcript, MAX_READ_THREAD_MESSAGES);
}

function mergeEvidenceRecords(
  existing: readonly OrchestrationEvidenceRecord[] = [],
  derived: readonly OrchestrationEvidenceRecord[],
): readonly OrchestrationEvidenceRecord[] {
  const records = new Map<string, OrchestrationEvidenceRecord>();
  for (const record of existing) {
    records.set(record.id, record);
  }
  for (const record of derived) {
    records.set(record.id, {
      ...records.get(record.id),
      ...record,
    });
  }
  return capEvidenceRecords(
    [...records.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  );
}

function capEvidenceRecords(
  records: readonly OrchestrationEvidenceRecord[],
): readonly OrchestrationEvidenceRecord[] {
  if (records.length <= MAX_EVIDENCE_RECORDS_PER_CHILD) {
    return records;
  }
  const priority = records.filter(
    (record) =>
      record.status === "blocked" ||
      record.status === "failed" ||
      record.source === "orchestrator-accepted",
  );
  const remaining = records.filter((record) => !priority.includes(record));
  return [...priority, ...remaining].slice(0, MAX_EVIDENCE_RECORDS_PER_CHILD);
}

function parentEvidenceIndex(
  store: AppStoreInternals,
  children: readonly OrchestrationChildThread[],
): ReadonlyMap<string, readonly OrchestrationEvidenceRecord[]> {
  const childById = new Map(children.map((child) => [child.id, child] as const));
  const parentKeys = new Set(
    children.map((child) =>
      sessionKey({
        workspaceId: child.parentWorkspaceId,
        sessionId: child.parentSessionId,
      }),
    ),
  );
  const index = new Map<string, OrchestrationEvidenceRecord[]>();
  for (const key of parentKeys) {
    const transcript = store.sessionState.transcriptCache.get(key) ?? [];
    for (const record of evidenceFromParentTranscript(childById, transcript)) {
      const bucket = index.get(record.childThreadId) ?? [];
      bucket.push(record);
      index.set(record.childThreadId, bucket);
    }
  }
  return index;
}

function evidenceFromChildTranscript(
  child: OrchestrationChildThread,
  transcript: readonly TranscriptMessage[],
): readonly OrchestrationEvidenceRecord[] {
  return transcript.flatMap((message): readonly OrchestrationEvidenceRecord[] => {
    if (message.kind === "tool") {
      return [commandEvidenceFromTool(child, message)];
    }
    if (message.kind !== "message" || message.role !== "assistant") {
      return [];
    }
    const text = message.text.trim();
    if (!text) {
      return [];
    }
    const severity = severityFromText(text);
    const isBlocker = looksLikeBlocker(text);
    return [
      {
        id: evidenceId("worker", message.id),
        childThreadId: child.id,
        kind: isBlocker ? "blocker" : severity ? "review_finding" : "worker_report",
        source: "worker-reported",
        status: isBlocker ? "blocked" : "reported",
        title: isBlocker
          ? "Worker reported blocker"
          : severity
            ? `${severity} review finding`
            : "Worker reported output",
        detail: truncateEvidenceDetail(text),
        ...(severity ? { severity } : {}),
        parentSessionId: child.parentSessionId,
        childSessionId: child.childSessionId,
        createdAt: message.createdAt,
      },
    ];
  });
}

function commandEvidenceFromTool(
  child: OrchestrationChildThread,
  tool: TimelineToolCall,
): OrchestrationEvidenceRecord {
  const command = commandFromToolInput(tool.input);
  return {
    id: evidenceId("command", tool.callId),
    childThreadId: child.id,
    kind: "command",
    source: "command",
    status: tool.status === "running" ? "running" : tool.status === "error" ? "failed" : "passed",
    title: command && looksLikeTestCommand(command) ? "Test command run" : "Command or tool run",
    detail: tool.detail ? truncateEvidenceDetail(tool.detail) : tool.label,
    ...(command ? { command } : {}),
    toolName: tool.toolName,
    parentSessionId: child.parentSessionId,
    childSessionId: child.childSessionId,
    createdAt: tool.createdAt,
  };
}

function evidenceFromParentTranscript(
  childById: ReadonlyMap<string, OrchestrationChildThread>,
  transcript: readonly TranscriptMessage[],
): readonly OrchestrationEvidenceRecord[] {
  return transcript.flatMap((message): readonly OrchestrationEvidenceRecord[] => {
    if (message.kind === "message" && message.role === "assistant") {
      return explicitAcceptanceEvidenceFromParentMessage(childById, message);
    }
    if (message.kind !== "tool" || message.status !== "success" || !isRecord(message.output)) {
      return [];
    }
    const details = isRecord(message.output.details) ? message.output.details : undefined;
    if (!details) {
      return [];
    }
    const childId =
      typeof details.childThreadId === "string"
        ? details.childThreadId
        : typeof details.threadId === "string"
          ? details.threadId
          : undefined;
    const child = childId ? childById.get(childId) : undefined;
    if (!child) {
      return [];
    }
    if (details.action === readThreadAction && details.childThreadId === child.id) {
      return [
        {
          id: evidenceId("observed-read", message.callId),
          childThreadId: child.id,
          kind: "orchestrator_observation",
          source: "orchestrator-observed",
          status: "reported",
          title: "Orchestrator read child output",
          detail: truncateEvidenceDetail(textFromToolOutput(message.output)),
          parentSessionId: child.parentSessionId,
          childSessionId: child.childSessionId,
          createdAt: message.createdAt,
        },
      ];
    }
    if (details.action === sendMessageToThreadAction && details.threadId === child.id) {
      return [
        {
          id: evidenceId("follow-up", message.callId),
          childThreadId: child.id,
          kind: "orchestrator_action",
          source: "orchestrator-action",
          status: "reported",
          title: "Orchestrator sent follow-up",
          ...(typeof details.message === "string"
            ? { detail: truncateEvidenceDetail(details.message) }
            : {}),
          parentSessionId: child.parentSessionId,
          childSessionId: child.childSessionId,
          createdAt: message.createdAt,
        },
      ];
    }
    return [];
  });
}

function explicitAcceptanceEvidenceFromParentMessage(
  childById: ReadonlyMap<string, OrchestrationChildThread>,
  message: Extract<TranscriptMessage, { kind: "message" }>,
): readonly OrchestrationEvidenceRecord[] {
  const records: OrchestrationEvidenceRecord[] = [];
  for (const line of message.text.split("\n")) {
    const match = /^orchestrator-accepted:\s*(\S+)\s*(.*)$/i.exec(line.trim());
    if (!match) {
      continue;
    }
    const child = childById.get(match[1] ?? "");
    if (!child) {
      continue;
    }
    records.push({
      id: evidenceId("accepted", `${message.id}:${child.id}`),
      childThreadId: child.id,
      kind: "orchestrator_acceptance",
      source: "orchestrator-accepted",
      status: "accepted",
      title: "Orchestrator accepted child evidence",
      detail: truncateEvidenceDetail(match[2] || message.text),
      parentSessionId: child.parentSessionId,
      childSessionId: child.childSessionId,
      createdAt: message.createdAt,
    });
  }
  return records;
}

function blockerEvidenceFromChildStatus(
  child: OrchestrationChildThread,
  status: OrchestrationChildThreadStatus,
  updatedAt: string,
): readonly OrchestrationEvidenceRecord[] {
  if (status !== "failed") {
    return [];
  }
  return [
    {
      id: evidenceId("blocker-status", child.id),
      childThreadId: child.id,
      kind: "blocker",
      source: "blocker",
      status: "blocked",
      title: "Child thread failed",
      detail: child.latestTranscript,
      parentSessionId: child.parentSessionId,
      childSessionId: child.childSessionId,
      createdAt: updatedAt,
    },
  ];
}

function commandFromToolInput(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  for (const key of ["cmd", "command", "script"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function looksLikeTestCommand(command: string): boolean {
  return /\b(test|spec|typecheck|build|playwright|vitest|jest|tsc)\b/i.test(command);
}

function looksLikeBlocker(text: string): boolean {
  return /^\s*(?:\[?BLOCKER\]?|blocked)\s*:/i.test(text);
}

function severityFromText(text: string): OrchestrationEvidenceRecord["severity"] | undefined {
  const match = /^\s*\[?(P[0-3])\]?\s*:/.exec(text);
  return match?.[1] as OrchestrationEvidenceRecord["severity"] | undefined;
}

function truncateEvidenceDetail(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 260 ? `${normalized.slice(0, 257)}...` : normalized;
}

function evidenceId(prefix: string, sourceId: string): string {
  return `${prefix}:${sourceId}`;
}

async function workspaceGitRef(
  workspaceId: string,
  workspacePath: string,
): Promise<OrchestrationEvidenceRecord["git"] | undefined> {
  const [branch, head] = await gitOutputLines(workspacePath, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
    "HEAD",
  ]);
  const branchName = branch && branch !== "HEAD" ? branch : undefined;
  if (!branchName && !head) {
    return undefined;
  }
  return {
    workspaceId,
    ...(branchName ? { branchName } : {}),
    ...(head ? { headSha: head } : {}),
  };
}

async function gitOutputLines(
  workspacePath: string,
  args: readonly string[],
): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: workspacePath });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function childForToolCall(
  store: AppStoreInternals,
  input: Pick<SpawnChildThreadInput, "parentWorkspaceId" | "parentSessionId" | "sourceToolCallId">,
): OrchestrationChildThread | undefined {
  if (!input.sourceToolCallId) {
    return undefined;
  }
  return store.state.orchestrationChildren.find(
    (child) =>
      child.sourceToolCallId === input.sourceToolCallId &&
      child.parentWorkspaceId === input.parentWorkspaceId &&
      child.parentSessionId === input.parentSessionId,
  );
}

function childToolCallKey(
  input: Pick<SpawnChildThreadInput, "parentWorkspaceId" | "parentSessionId" | "sourceToolCallId">,
): string {
  return `${input.parentWorkspaceId}\0${input.parentSessionId}\0${input.sourceToolCallId ?? ""}`;
}

function isTimelineToolCall(value: TranscriptMessage): value is TimelineToolCall {
  return (
    value.kind === "tool" &&
    "callId" in value &&
    "toolName" in value &&
    "status" in value &&
    typeof value.callId === "string" &&
    typeof value.toolName === "string"
  );
}

function toOrchestrationStatus(
  status: string,
  sessionRef: SessionRef,
  store: AppStoreInternals,
): OrchestrationChildThreadStatus {
  if (store.getQueuedComposerMessages(sessionRef).length > 0) {
    return "waiting";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "running") {
    return "running";
  }
  // An idle session that has never produced a run is queued, not complete. The
  // child record is inserted before its prompt is void-fired, so without this a
  // never-started child would read "complete" and trigger a false parent wake.
  if (!hasStartedRun(store, sessionRef)) {
    return "queued";
  }
  return "complete";
}

function hasStartedRun(store: AppStoreInternals, sessionRef: SessionRef): boolean {
  const transcript = store.sessionState.transcriptCache.get(sessionKey(sessionRef)) ?? [];
  return transcript.some(isWorkerResponse);
}

function toChildTranscript(
  transcript: readonly TranscriptMessage[],
  limit: number,
): readonly OrchestrationChildTranscriptMessage[] {
  const messages: OrchestrationChildTranscriptMessage[] = [];
  for (let index = transcript.length - 1; index >= 0 && messages.length < limit; index -= 1) {
    const message = transcript[index];
    if (!message) {
      continue;
    }
    const text = transcriptText(message);
    if (!text) {
      continue;
    }
    messages.push({
      id: message.id,
      role: transcriptRole(message),
      text,
      createdAt: message.createdAt,
    });
  }
  return messages.reverse();
}

function recentTranscriptItems(
  transcript: readonly TranscriptMessage[],
): readonly TranscriptMessage[] {
  return transcript.slice(-MAX_CHILD_TRANSCRIPT_MESSAGES);
}

function transcriptText(message: TranscriptMessage): string {
  if (message.kind === "message") {
    return message.text;
  }
  if (message.kind === "activity") {
    return message.detail ? `${message.label}: ${message.detail}` : message.label;
  }
  if (message.kind === "tool") {
    return message.detail ? `${message.label}: ${message.detail}` : message.label;
  }
  return message.metadata ? `${message.label}: ${message.metadata}` : message.label;
}

function transcriptRole(message: TranscriptMessage): OrchestrationChildTranscriptMessage["role"] {
  if (message.kind !== "message") {
    return "system";
  }
  if (message.role === "user") {
    return "parent";
  }
  if (message.role === "assistant") {
    return "child";
  }
  return "system";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function titleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= CHILD_TITLE_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, CHILD_TITLE_LIMIT - 3).trimEnd()}...`;
}
