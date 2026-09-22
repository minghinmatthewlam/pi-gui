import { defineService, type Context, type ReplicatedState } from "@earendil-works/chord";

export interface ReviewTarget {
  checkout: string;
  repository: string;
  number: number;
  url: string;
  title: string;
  branch: string;
  base: string;
  head: string;
  mergeBase: string;
  localHead: string;
  dirty: boolean;
  files: string[];
}

export interface Finding {
  id: string;
  priority: "P1" | "P2" | "P3";
  title: string;
  body: string;
  path: string;
  line: number;
}

export type ReviewStatus =
  "requested" | "running" | "completed" | "incomplete" | "failed" | "aborted" | "interrupted";

export interface ReviewRecord {
  version: 1;
  id: string;
  target: ReviewTarget;
  status: ReviewStatus;
  requestedAt: number;
  finishedAt: number | null;
  summary: string;
  findings: Finding[];
  recorded: boolean;
  detail: string;
}

export interface ReviewState {
  target: ReviewTarget | null;
  review: ReviewRecord | null;
  refreshing: boolean;
  error: string | null;
}

export interface FixDraft {
  title: string;
  prompt: string;
  files: { path: string; line: number }[];
}

export interface ReviewService {
  state: ReplicatedState<ReviewState>;
  refresh(input: Record<string, never>, context: Context): Promise<void>;
  request(input: { requestId: string }, context: Context): Promise<{ reviewId: string }>;
  prepareFix(input: { reviewId: string; findingId: string }, context: Context): Promise<FixDraft>;
}

export const PRReview = defineService<ReviewService>("pi-gui.examples.pr-review.v1");

export function staleReason(review: ReviewRecord, current: ReviewTarget | null): string | null {
  if (!current) return "The current PR could not be verified. Refresh before using these findings.";
  if (review.target.repository !== current.repository || review.target.number !== current.number)
    return "This checkout now belongs to a different PR.";
  if (review.target.head !== current.head || review.target.base !== current.base)
    return "The PR changed after this review. Review the new revision before preparing a fix.";
  if (current.localHead !== review.target.head)
    return "The checkout is no longer at the reviewed revision.";
  return null;
}
