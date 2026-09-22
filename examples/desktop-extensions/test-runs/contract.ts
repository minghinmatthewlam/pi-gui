import { defineService, type Context, type ReplicatedState } from "@earendil-works/chord";

export const ENTRY_TYPE = "pi-gui.example.test-runs.v1";
export const OUTPUT_LIMIT = 32 * 1024;

export interface Suite {
  id: string;
  label: string;
  command: string;
  timeoutSeconds: number;
}

export type RunOutcome =
  | { kind: "running" }
  | { kind: "cancelling" }
  | { kind: "completed"; exitCode: number }
  | { kind: "cancelled" }
  | { kind: "timedOut" }
  | { kind: "executionError"; message: string }
  | { kind: "interrupted" };

export interface RunRecord {
  id: string;
  requestId: string;
  suiteId: string;
  label: string;
  command: string;
  startedAt: string;
  endedAt: string | null;
  outcome: RunOutcome;
  output: string;
  outputBytes: number;
  truncated: boolean;
}

export interface TestRunsState {
  ready: boolean;
  error: string | null;
  suites: Suite[];
  runs: RunRecord[];
}

export interface StartRequest {
  suiteId: string;
  requestId: string;
}

export interface TestRunsService {
  state: ReplicatedState<TestRunsState>;
  start(request: StartRequest, context: Context): Promise<{ runId: string }>;
  cancel(request: { runId: string }, context: Context): Promise<void>;
}

export const TestRuns = defineService<TestRunsService>("pi-gui.example.test-runs.v1");

export function isActive(run: RunRecord): boolean {
  return run.outcome.kind === "running" || run.outcome.kind === "cancelling";
}

export function outcomeLabel(run: RunRecord): string {
  switch (run.outcome.kind) {
    case "running":
      return "Running";
    case "cancelling":
      return "Stopping";
    case "completed":
      return run.outcome.exitCode === 0
        ? "Command completed · exit 0"
        : `Command failed · exit ${run.outcome.exitCode}`;
    case "cancelled":
      return "Cancelled";
    case "timedOut":
      return "Timed out";
    case "executionError":
      return `Could not run · ${run.outcome.message}`;
    case "interrupted":
      return "Interrupted · result unknown";
  }
}
