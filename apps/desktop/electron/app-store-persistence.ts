import type {
  AppView,
  ExtensionCommandCompatibilityRecord,
  ModelSettingsScopeMode,
  NotificationPreferences,
  OrchestrationEvidenceRecord,
  OrchestrationChildThread,
  OrchestrationChildTranscriptMessage,
  OrchestrationSupervisionLoop,
  ThemeMode,
  ThemePresetId,
} from "../src/desktop-state";
import { isThemeMode, isThemePresetId } from "../src/desktop-state";
import type { ModelSettingsSnapshot } from "@pi-gui/session-driver/runtime-types";
import { readJsonWithBackup, writeFileAtomicQueued } from "./atomic-file-write";

export interface PersistedUiState {
  readonly version?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly activeView?: AppView;
  readonly composerDraft?: string;
  readonly composerDraftsBySession?: Record<string, string>;
  readonly extensionCommandCompatibilityByWorkspace?: Record<
    string,
    readonly ExtensionCommandCompatibilityRecord[]
  >;
  readonly notificationPreferences?: Partial<NotificationPreferences>;
  readonly integratedTerminalShell?: string;
  readonly lastViewedAtBySession?: Record<string, string>;
  readonly pinnedAtBySession?: Record<string, string>;
  readonly pinnedSessionOrder?: readonly string[];
  readonly workspaceOrder?: readonly string[];
  readonly modelSettingsScopeMode?: ModelSettingsScopeMode;
  readonly appGlobalModelSettings?: ModelSettingsSnapshot;
  readonly sidebarCollapsed?: boolean;
  readonly allowMultiple?: boolean;
  readonly enableTransparency?: boolean;
  readonly themeMode?: ThemeMode;
  readonly themePresetId?: ThemePresetId;
  readonly orchestrationChildren?: readonly OrchestrationChildThread[];
}

export interface LegacyPersistedUiState extends PersistedUiState {
  readonly composerAttachmentsBySession?: Record<string, readonly unknown[]>;
  readonly transcripts?: Record<string, readonly unknown[]>;
}

export async function readPersistedUiState(
  uiStateFilePath: string,
): Promise<LegacyPersistedUiState> {
  const result = await readJsonWithBackup<unknown>(uiStateFilePath);
  if (result.corrupted) {
    // Surface corruption instead of silently returning `{}` (which the next
    // write would then persist over the last good state, losing pins, drafts,
    // workspace order, etc.). A recovery from `.bak` still counts as corrupt so
    // the operator sees that the primary file needs attention.
    console.error(
      `[app-store] corrupt ui-state at ${uiStateFilePath}` +
        (result.recovered
          ? " — recovered from backup"
          : " — no usable backup, starting from empty state"),
    );
  }
  const parsed = result.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const candidate = parsed as Record<string, unknown>;

  return {
    version: toPersistedVersion(candidate.version),
    selectedWorkspaceId: stringValue(candidate.selectedWorkspaceId),
    selectedSessionId: stringValue(candidate.selectedSessionId),
    activeView: toAppView(candidate.activeView),
    composerDraft: stringValue(candidate.composerDraft) ?? "",
    composerDraftsBySession: toStringRecord(candidate.composerDraftsBySession),
    extensionCommandCompatibilityByWorkspace: toPersistedCompatibilityByWorkspace(
      candidate.extensionCommandCompatibilityByWorkspace,
    ),
    notificationPreferences: toNotificationPreferences(candidate.notificationPreferences),
    integratedTerminalShell:
      typeof candidate.integratedTerminalShell === "string"
        ? candidate.integratedTerminalShell
        : undefined,
    lastViewedAtBySession: toStringRecord(candidate.lastViewedAtBySession),
    pinnedAtBySession: toStringRecord(candidate.pinnedAtBySession),
    pinnedSessionOrder: toStringArray(candidate.pinnedSessionOrder),
    workspaceOrder: toStringArray(candidate.workspaceOrder),
    modelSettingsScopeMode:
      candidate.modelSettingsScopeMode === "per-repo" ||
      candidate.modelSettingsScopeMode === "app-global"
        ? candidate.modelSettingsScopeMode
        : undefined,
    appGlobalModelSettings: toPersistedModelSettingsSnapshot(candidate.appGlobalModelSettings),
    sidebarCollapsed:
      typeof candidate.sidebarCollapsed === "boolean" ? candidate.sidebarCollapsed : undefined,
    allowMultiple:
      typeof candidate.allowMultiple === "boolean" ? candidate.allowMultiple : undefined,
    enableTransparency:
      typeof candidate.enableTransparency === "boolean" ? candidate.enableTransparency : undefined,
    themeMode: toThemeMode(candidate.themeMode),
    themePresetId: toThemePresetId(candidate.themePresetId),
    orchestrationChildren: toPersistedOrchestrationChildren(candidate.orchestrationChildren),
    composerAttachmentsBySession: toObjectArrayRecord(candidate.composerAttachmentsBySession),
    transcripts: toObjectArrayRecord(candidate.transcripts),
  };
}

export async function writePersistedUiState(
  uiStateFilePath: string,
  payload: PersistedUiState,
): Promise<void> {
  const serialized = `${JSON.stringify(
    {
      ...payload,
      version: 15,
    } satisfies PersistedUiState,
    null,
    2,
  )}\n`;
  await writeFileAtomicQueued(uiStateFilePath, serialized);
}

function toThemeMode(value: unknown): ThemeMode | undefined {
  return isThemeMode(value) ? value : undefined;
}

function toThemePresetId(value: unknown): ThemePresetId | undefined {
  return isThemePresetId(value) ? value : undefined;
}

function toAppView(value: unknown): AppView | undefined {
  return value === "threads" ||
    value === "new-thread" ||
    value === "skills" ||
    value === "extensions" ||
    value === "settings"
    ? value
    : undefined;
}

function toPersistedVersion(value: unknown): NonNullable<PersistedUiState["version"]> | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 15
    ? (value as NonNullable<PersistedUiState["version"]>)
    : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function toPersistedOrchestrationChildren(value: unknown): OrchestrationChildThread[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((entry): OrchestrationChildThread[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const candidate = entry as Record<string, unknown>;
    const id = stringValue(candidate.id);
    const parentWorkspaceId = stringValue(candidate.parentWorkspaceId);
    const parentSessionId = stringValue(candidate.parentSessionId);
    const childWorkspaceId = stringValue(candidate.childWorkspaceId) ?? parentWorkspaceId ?? "";
    const childSessionId = stringValue(candidate.childSessionId) ?? "";
    const title = stringValue(candidate.title);
    const goal = stringValue(candidate.goal);
    const createdAt = stringValue(candidate.createdAt);
    const updatedAt = stringValue(candidate.updatedAt);
    if (
      !id ||
      !parentWorkspaceId ||
      !parentSessionId ||
      !title ||
      !goal ||
      !createdAt ||
      !updatedAt
    ) {
      return [];
    }

    const transcript = Array.isArray(candidate.transcript)
      ? candidate.transcript.flatMap((message): OrchestrationChildTranscriptMessage[] => {
          if (!message || typeof message !== "object") {
            return [];
          }
          const record = message as Record<string, unknown>;
          const messageId = stringValue(record.id);
          const role =
            record.role === "parent" || record.role === "child" || record.role === "system"
              ? record.role
              : undefined;
          const text = stringValue(record.text);
          const messageCreatedAt = stringValue(record.createdAt);
          if (!messageId || !role || !text || !messageCreatedAt) {
            return [];
          }
          return [{ id: messageId, role, text, createdAt: messageCreatedAt }];
        })
      : [];
    const retainedTranscript = transcript.slice(-MAX_PERSISTED_ORCHESTRATION_TRANSCRIPT_MESSAGES);

    const sourceToolCallId = stringValue(candidate.sourceToolCallId);
    const status = toOrchestrationStatus(candidate.status);
    const supervisionLoop = toPersistedSupervisionLoop(candidate.supervisionLoop, status);
    return [
      {
        id,
        ...(sourceToolCallId ? { sourceToolCallId } : {}),
        parentWorkspaceId,
        parentSessionId,
        childWorkspaceId,
        childSessionId,
        title,
        goal,
        status,
        latestTranscript:
          stringValue(candidate.latestTranscript) || retainedTranscript.at(-1)?.text || goal,
        transcript: retainedTranscript,
        evidence: toPersistedEvidence(candidate.evidence, id),
        ...(supervisionLoop ? { supervisionLoop } : {}),
        createdAt,
        updatedAt,
      },
    ];
  });
}

function toPersistedEvidence(value: unknown, childThreadId: string): OrchestrationEvidenceRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const records = value.flatMap((entry): OrchestrationEvidenceRecord[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const candidate = entry as Record<string, unknown>;
    const id = stringValue(candidate.id);
    const kind = toEvidenceKind(candidate.kind);
    const source = toEvidenceSource(candidate.source);
    const status = toEvidenceStatus(candidate.status);
    const title = stringValue(candidate.title);
    const createdAt = stringValue(candidate.createdAt);
    if (!id || !kind || !source || !status || !title || !createdAt) {
      return [];
    }

    const gitCandidate = candidate.git;
    const git =
      gitCandidate && typeof gitCandidate === "object"
        ? toEvidenceGit(gitCandidate as Record<string, unknown>)
        : undefined;

    return [
      {
        id,
        childThreadId,
        kind,
        source,
        status,
        title,
        ...(stringValue(candidate.detail) ? { detail: stringValue(candidate.detail) } : {}),
        ...(stringValue(candidate.command) ? { command: stringValue(candidate.command) } : {}),
        ...(stringValue(candidate.toolName) ? { toolName: stringValue(candidate.toolName) } : {}),
        ...(toEvidenceSeverity(candidate.severity)
          ? { severity: toEvidenceSeverity(candidate.severity) }
          : {}),
        ...(stringValue(candidate.parentSessionId)
          ? { parentSessionId: stringValue(candidate.parentSessionId) }
          : {}),
        ...(stringValue(candidate.childSessionId)
          ? { childSessionId: stringValue(candidate.childSessionId) }
          : {}),
        ...(git ? { git } : {}),
        createdAt,
        ...(stringValue(candidate.updatedAt)
          ? { updatedAt: stringValue(candidate.updatedAt) }
          : {}),
      },
    ];
  });
  return records.slice(0, MAX_PERSISTED_ORCHESTRATION_EVIDENCE_RECORDS);
}

function toEvidenceGit(
  value: Record<string, unknown>,
): OrchestrationEvidenceRecord["git"] | undefined {
  const workspaceId = stringValue(value.workspaceId);
  if (!workspaceId) {
    return undefined;
  }
  return {
    workspaceId,
    ...(stringValue(value.branchName) ? { branchName: stringValue(value.branchName) } : {}),
    ...(stringValue(value.headSha) ? { headSha: stringValue(value.headSha) } : {}),
  };
}

function toEvidenceKind(value: unknown): OrchestrationEvidenceRecord["kind"] | undefined {
  return value === "worker_report" ||
    value === "orchestrator_acceptance" ||
    value === "orchestrator_observation" ||
    value === "orchestrator_action" ||
    value === "command" ||
    value === "review_finding" ||
    value === "blocker"
    ? value
    : undefined;
}

function toEvidenceSource(value: unknown): OrchestrationEvidenceRecord["source"] | undefined {
  return value === "worker-reported" ||
    value === "orchestrator-accepted" ||
    value === "orchestrator-observed" ||
    value === "orchestrator-action" ||
    value === "command" ||
    value === "review" ||
    value === "blocker"
    ? value
    : undefined;
}

function toEvidenceStatus(value: unknown): OrchestrationEvidenceRecord["status"] | undefined {
  return value === "reported" ||
    value === "accepted" ||
    value === "running" ||
    value === "passed" ||
    value === "failed" ||
    value === "blocked"
    ? value
    : undefined;
}

function toEvidenceSeverity(value: unknown): OrchestrationEvidenceRecord["severity"] | undefined {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3" ? value : undefined;
}

function toPersistedSupervisionLoop(
  value: unknown,
  lastChildStatus: OrchestrationChildThread["status"],
): OrchestrationSupervisionLoop | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const id = stringValue(candidate.id);
  const status = toSupervisionStatus(candidate.status);
  const gate = toSupervisionGate(candidate.gate);
  const intervalMs = numberValue(candidate.intervalMs);
  const iterationCount = numberValue(candidate.iterationCount);
  const lastCheckedAt = stringValue(candidate.lastCheckedAt);
  const reason = stringValue(candidate.reason);
  if (
    !id ||
    !status ||
    !gate ||
    !intervalMs ||
    iterationCount === undefined ||
    !lastCheckedAt ||
    !reason
  ) {
    return undefined;
  }
  return {
    id,
    status,
    gate,
    intervalMs,
    iterationCount,
    lastCheckedAt,
    ...(stringValue(candidate.nextRunAt) ? { nextRunAt: stringValue(candidate.nextRunAt) } : {}),
    reason,
    lastChildStatus: toOptionalOrchestrationStatus(candidate.lastChildStatus) ?? lastChildStatus,
    ...(stringValue(candidate.stoppedAt) ? { stoppedAt: stringValue(candidate.stoppedAt) } : {}),
  };
}

function toSupervisionStatus(value: unknown): OrchestrationSupervisionLoop["status"] | undefined {
  return value === "monitoring" || value === "attention" || value === "stopped" ? value : undefined;
}

function toSupervisionGate(value: unknown): OrchestrationSupervisionLoop["gate"] | undefined {
  return value === "continue" || value === "stop" || value === "wake" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toNotificationPreferences(value: unknown): Partial<NotificationPreferences> | undefined {
  const candidate = objectRecord(value);
  if (!candidate) {
    return undefined;
  }
  const preferences = {
    ...(typeof candidate.backgroundCompletion === "boolean"
      ? { backgroundCompletion: candidate.backgroundCompletion }
      : {}),
    ...(typeof candidate.backgroundFailure === "boolean"
      ? { backgroundFailure: candidate.backgroundFailure }
      : {}),
    ...(typeof candidate.attentionNeeded === "boolean"
      ? { attentionNeeded: candidate.attentionNeeded }
      : {}),
  };
  return Object.keys(preferences).length > 0 ? preferences : undefined;
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  const candidate = objectRecord(value);
  if (!candidate) {
    return undefined;
  }

  const entries = Object.entries(candidate).filter(
    (entry): entry is [string, string] =>
      Boolean(entry[0]) && typeof entry[1] === "string" && Boolean(entry[1]),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function toPersistedCompatibilityByWorkspace(
  value: unknown,
): Record<string, readonly ExtensionCommandCompatibilityRecord[]> | undefined {
  const candidate = objectRecord(value);
  if (!candidate) {
    return undefined;
  }

  const entries = Object.entries(candidate).flatMap(([workspaceId, records]) => {
    if (!workspaceId || !Array.isArray(records)) {
      return [];
    }
    const validRecords = records.flatMap((record) => {
      const parsed = toPersistedCompatibilityRecord(record);
      return parsed ? [parsed] : [];
    });
    return validRecords.length > 0 ? [[workspaceId, validRecords] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function toPersistedCompatibilityRecord(
  value: unknown,
): ExtensionCommandCompatibilityRecord | undefined {
  const candidate = objectRecord(value);
  if (
    !candidate ||
    typeof candidate.commandName !== "string" ||
    typeof candidate.extensionPath !== "string" ||
    (candidate.status !== "supported" && candidate.status !== "terminal-only") ||
    typeof candidate.message !== "string" ||
    typeof candidate.capability !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return undefined;
  }
  return {
    commandName: candidate.commandName,
    extensionPath: candidate.extensionPath,
    status: candidate.status,
    message: candidate.message,
    capability: candidate.capability,
    updatedAt: candidate.updatedAt,
  };
}

function toObjectArrayRecord(value: unknown): Record<string, readonly unknown[]> | undefined {
  const candidate = objectRecord(value);
  if (!candidate) {
    return undefined;
  }

  const entries = Object.entries(candidate).flatMap(([key, values]) => {
    if (!key || !Array.isArray(values)) {
      return [];
    }
    const objectValues = values.filter((entry) => Boolean(objectRecord(entry)));
    return objectValues.length > 0 ? [[key, objectValues] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toOrchestrationStatus(value: unknown): OrchestrationChildThread["status"] {
  return toOptionalOrchestrationStatus(value) ?? "running";
}

function toOptionalOrchestrationStatus(
  value: unknown,
): OrchestrationChildThread["status"] | undefined {
  return value === "queued" ||
    value === "waiting" ||
    value === "complete" ||
    value === "failed" ||
    value === "running"
    ? value
    : undefined;
}

function toPersistedModelSettingsSnapshot(value: unknown): ModelSettingsSnapshot | undefined {
  const candidate = objectRecord(value);
  if (!candidate) {
    return undefined;
  }
  const enabledModelPatterns = Array.isArray(candidate.enabledModelPatterns)
    ? candidate.enabledModelPatterns.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    ...(typeof candidate.defaultProvider === "string"
      ? { defaultProvider: candidate.defaultProvider }
      : {}),
    ...(typeof candidate.defaultModelId === "string"
      ? { defaultModelId: candidate.defaultModelId }
      : {}),
    ...(typeof candidate.defaultThinkingLevel === "string"
      ? {
          defaultThinkingLevel:
            candidate.defaultThinkingLevel as ModelSettingsSnapshot["defaultThinkingLevel"],
        }
      : {}),
    enabledModelPatterns,
  };
}
const MAX_PERSISTED_ORCHESTRATION_TRANSCRIPT_MESSAGES = 40;
const MAX_PERSISTED_ORCHESTRATION_EVIDENCE_RECORDS = 80;
