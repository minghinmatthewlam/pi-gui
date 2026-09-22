import { randomUUID } from "node:crypto";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
  ENTRY_TYPE,
  OUTPUT_LIMIT,
  isActive,
  type RunOutcome,
  type RunRecord,
  type StartRequest,
  type Suite,
  type TestRunsState,
} from "./contract.ts";

interface PersistedRun {
  version: 1;
  run: RunRecord;
}

interface Entry {
  type: string;
  customType?: string;
  data?: unknown;
}

interface ActiveRun {
  id: string;
  controller: AbortController;
  done: Promise<RunRecord>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): RunRecord | null {
  if (!object(value) || value.version !== 1 || !object(value.run)) return null;
  const run = value.run;
  if (
    !["id", "requestId", "suiteId", "label", "command", "startedAt", "output"].every(
      (key) => typeof run[key] === "string",
    ) ||
    !(run.endedAt === null || typeof run.endedAt === "string") ||
    typeof run.outputBytes !== "number" ||
    !Number.isSafeInteger(run.outputBytes) ||
    run.outputBytes < 0 ||
    typeof run.truncated !== "boolean" ||
    !object(run.outcome)
  ) {
    return null;
  }
  const savedOutcome = run.outcome;
  let outcome: RunOutcome;
  switch (savedOutcome.kind) {
    case "running":
    case "cancelling":
    case "cancelled":
    case "timedOut":
    case "interrupted":
      outcome = { kind: savedOutcome.kind };
      break;
    case "completed":
      if (typeof savedOutcome.exitCode !== "number" || !Number.isInteger(savedOutcome.exitCode))
        return null;
      outcome = { kind: "completed", exitCode: savedOutcome.exitCode };
      break;
    case "executionError":
      if (typeof savedOutcome.message !== "string") return null;
      outcome = { kind: "executionError", message: savedOutcome.message };
      break;
    default:
      return null;
  }
  // Only retain the explicitly checked fields; session entries are external input.
  return {
    id: String(run.id),
    requestId: String(run.requestId),
    suiteId: String(run.suiteId),
    label: String(run.label),
    command: String(run.command),
    startedAt: String(run.startedAt),
    endedAt: run.endedAt,
    outcome,
    output: String(run.output),
    outputBytes: run.outputBytes,
    truncated: run.truncated,
  };
}

function parseStart(value: StartRequest): StartRequest {
  if (
    !object(value) ||
    typeof value.suiteId !== "string" ||
    typeof value.requestId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,120}$/.test(value.requestId)
  ) {
    throw new Error("A configured suite and a valid request ID are required.");
  }
  return { suiteId: value.suiteId, requestId: value.requestId };
}

/** One owner shared by the Pi command, tool and optional desktop facet. */
export class TestRunOwner {
  private readonly records = new Map<string, RunRecord>();
  private readonly requests = new Map<string, RunRecord>();
  private readonly listeners = new Set<(state: TestRunsState) => void>();
  private active: ActiveRun | null = null;
  private ready = false;
  private error: string | null = null;
  private cwd = "";
  private readonly suites: readonly Suite[];
  private readonly operations: BashOperations;
  private readonly append: (customType: string, data: PersistedRun) => void;

  constructor(
    suites: readonly Suite[],
    operations: BashOperations,
    append: (customType: string, data: PersistedRun) => void,
  ) {
    this.suites = suites;
    this.operations = operations;
    this.append = append;
  }

  snapshot(): TestRunsState {
    return {
      ready: this.ready,
      error: this.error,
      suites: this.suites.map((suite) => ({ ...suite })),
      runs: [...this.records.values()].slice(-20).map((run) => structuredClone(run)),
    };
  }

  subscribe(listener: (state: TestRunsState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  restore(cwd: string, branch: readonly Entry[]): void {
    if (this.active) throw new Error("Stop the active test run before restoring a branch.");
    this.records.clear();
    this.requests.clear();
    this.cwd = cwd;
    this.error = null;
    for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const record = parseRecord(entry.data);
      if (!record) {
        this.error = "Some saved test run records could not be read.";
        continue;
      }
      if (isActive(record)) record.outcome = { kind: "interrupted" };
      this.records.set(record.id, record);
      this.requests.set(record.requestId, record);
    }
    this.ready = true;
    this.publish();
  }

  start(input: StartRequest, signal?: AbortSignal): { runId: string } {
    signal?.throwIfAborted();
    if (!this.ready) throw new Error("The test run session is unavailable.");
    const request = parseStart(input);
    const previous = this.requests.get(request.requestId);
    if (previous) {
      if (previous.suiteId !== request.suiteId) {
        throw new Error("That request ID already belongs to another suite.");
      }
      return { runId: previous.id };
    }
    const suite = this.suites.find((candidate) => candidate.id === request.suiteId);
    if (!suite) throw new Error("Unknown test suite.");
    if (this.active) throw new Error("A test run is already active in this session.");
    const run: RunRecord = {
      id: randomUUID(),
      requestId: request.requestId,
      suiteId: suite.id,
      label: suite.label,
      command: suite.command,
      startedAt: new Date().toISOString(),
      endedAt: null,
      outcome: { kind: "running" },
      output: "",
      outputBytes: 0,
      truncated: false,
    };
    // Do not launch work if the initial session record cannot be saved.
    this.persist(run);
    this.records.set(run.id, run);
    this.requests.set(run.requestId, run);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    // Defer execution one microtask so cancellation and the busy guard own it first.
    const done = Promise.resolve().then(() => this.execute(run, suite, controller.signal));
    this.active = { id: run.id, controller, done };
    const detachAbort = () => signal?.removeEventListener("abort", onAbort);
    done.then(detachAbort, detachAbort);
    this.publish();
    return { runId: run.id };
  }

  async wait(runId: string): Promise<RunRecord> {
    if (this.active?.id === runId) return this.active.done;
    const record = this.records.get(runId);
    if (!record) throw new Error("Unknown test run.");
    return structuredClone(record);
  }

  async cancel(input: { runId: string }): Promise<void> {
    if (!object(input) || typeof input.runId !== "string") throw new Error("A run ID is required.");
    const record = this.records.get(input.runId);
    if (!record) throw new Error("Unknown test run.");
    if (this.active?.id !== input.runId) return;
    record.outcome = { kind: "cancelling" };
    this.active.controller.abort();
    this.publish();
    await this.active.done;
  }

  /** Used before tree changes and Pi runtime teardown, never on view close. */
  async suspend(): Promise<void> {
    this.ready = false;
    this.publish();
    await this.stopActive();
  }

  /** Navigation can fail without a session_tree event, so it must not suspend readiness. */
  async stopActive(): Promise<void> {
    if (this.active) await this.cancel({ runId: this.active.id });
  }

  private async execute(run: RunRecord, suite: Suite, signal: AbortSignal): Promise<RunRecord> {
    let tail = Buffer.alloc(0);
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    const flushOutput = () => {
      updateTimer = undefined;
      let start = 0;
      // A byte-limited UTF-8 tail can start inside a character.
      if (run.truncated) {
        while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start += 1;
      }
      run.output = tail.subarray(start).toString("utf8");
      this.publish();
    };
    try {
      const result = await this.operations.exec(suite.command, this.cwd, {
        signal,
        timeout: suite.timeoutSeconds,
        onData: (data) => {
          run.outputBytes += data.length;
          tail = Buffer.concat([tail, data]);
          if (tail.length > OUTPUT_LIMIT) tail = tail.subarray(-OUTPUT_LIMIT);
          run.truncated = run.outputBytes > OUTPUT_LIMIT;
          updateTimer ??= setTimeout(flushOutput, 75);
        },
      });
      run.outcome =
        result.exitCode === null
          ? { kind: "executionError", message: "Command terminated without an exit code." }
          : { kind: "completed", exitCode: result.exitCode };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      run.outcome = signal.aborted
        ? { kind: "cancelled" }
        : message.startsWith("timeout:")
          ? { kind: "timedOut" }
          : { kind: "executionError", message };
    } finally {
      if (updateTimer) clearTimeout(updateTimer);
      flushOutput();
      run.endedAt = new Date().toISOString();
      try {
        this.persist(run);
      } catch (error) {
        this.error = `Result could not be saved: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.active = null;
      this.publish();
    }
    return structuredClone(run);
  }

  private persist(run: RunRecord): void {
    this.append(ENTRY_TYPE, { version: 1, run: structuredClone(run) });
  }

  private publish(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // A disconnected view or tool subscriber must not interrupt process cleanup.
        this.listeners.delete(listener);
      }
    }
  }
}
