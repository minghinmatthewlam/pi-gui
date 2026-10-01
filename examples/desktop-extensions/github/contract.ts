import { defineService, type Context, type ReplicatedState } from "@earendil-works/chord";

export type CheckState = "passing" | "failing" | "pending" | "none";
export type ReviewDecision = "approved" | "changes_requested" | "review_required" | "none";

export interface Checks {
  state: CheckState;
  /** Names of failed checks, capped; `failedCount` is the real number. */
  failed: string[];
  failedCount: number;
  /** Checks that succeeded; skipped and neutral ones are counted apart, not as passing. */
  passed: number;
  skipped: number;
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

export interface GitHubState {
  status: "loading" | "ready" | "error";
  refreshing: boolean;
  /** `owner/name`, or null when unknown. */
  repo: string | null;
  /** When `gh` last returned this data. */
  fetchedAt: string | null;
  pullRequests: PullRequest[];
  issues: Issue[];
  error: string | null;
}

export interface GitHubService {
  state: ReplicatedState<GitHubState>;
  refresh(request: Record<string, never>, context: Context): Promise<void>;
}

/** The error when `gh` can't be started; the view offers the install page for it. */
export const GH_MISSING =
  "This view reads GitHub through the GitHub CLI. Install gh, run gh auth login, then refresh.";
export const GH_INSTALL_URL = "https://cli.github.com/";

export const GitHub = defineService<GitHubService>("pi-gui.example.github.v1");

export function initialState(): GitHubState {
  return {
    status: "loading",
    refreshing: false,
    repo: null,
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
