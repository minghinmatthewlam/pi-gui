import { defineService, type Context, type ReplicatedState } from "@earendil-works/chord";

export type CheckState = "passing" | "failing" | "pending" | "none";
export type ReviewDecision = "approved" | "changes_requested" | "review_required" | "none";

export interface Checks {
  state: CheckState;
  /** Names of failed checks, capped. */
  failed: string[];
  passed: number;
  total: number;
}

export interface PullRequest {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
  checks: Checks;
  review: ReviewDecision;
  url: string;
  additions: number | null;
  deletions: number | null;
}

export interface Issue {
  number: number;
  title: string;
  state: "open" | "closed";
  author: string;
  labels: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
  /** Plain text excerpt of the issue body, capped. Rendered with textContent only. */
  body: string;
  url: string;
}

export type Source =
  | { kind: "live" }
  | {
      kind: "snapshot";
      capturedAt: string;
      /** Why a snapshot is shown instead of live `gh` data. */
      reason: "configured" | "gh-missing";
    };

export interface GitHubState {
  status: "loading" | "ready" | "error";
  refreshing: boolean;
  /** `owner/name`, or null when unknown. */
  repo: string | null;
  source: Source | null;
  /** When this data was read (live) or loaded (snapshot). */
  fetchedAt: string | null;
  pullRequests: PullRequest[];
  issues: Issue[];
  error: string | null;
}

export interface GitHubService {
  state: ReplicatedState<GitHubState>;
  refresh(request: Record<string, never>, context: Context): Promise<void>;
}

export const GitHub = defineService<GitHubService>("pi-gui.example.github.v1");

export function initialState(): GitHubState {
  return {
    status: "loading",
    refreshing: false,
    repo: null,
    source: null,
    fetchedAt: null,
    pullRequests: [],
    issues: [],
    error: null,
  };
}

/** Failing CI or a changes-requested review on an open PR. */
export function needsAttention(pr: PullRequest): boolean {
  return (
    pr.state === "open" && (pr.checks.state === "failing" || pr.review === "changes_requested")
  );
}
