import { randomUUID } from "node:crypto";
import type { Finding, FixDraft, ReviewRecord, ReviewState, ReviewTarget } from "./contract";
import { staleReason } from "./contract";
import { relativeFile } from "./repository";

export const ENTRY = "pi-gui.pr-review.v1";
export const initialState = (): ReviewState => ({
  target: null,
  review: null,
  refreshing: false,
  error: null,
});
export const busy = (review: ReviewRecord | null) =>
  review?.status === "requested" || review?.status === "running";

export function requestRecord(target: ReviewTarget, id: string): ReviewRecord {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid review request ID.");
  if (target.localHead !== target.head)
    throw new Error("Check out the PR head before reviewing it.");
  return {
    version: 1,
    id,
    target,
    status: "requested",
    requestedAt: Date.now(),
    finishedAt: null,
    summary: "",
    findings: [],
    recorded: false,
    detail: "Requested from Pi; waiting for the review turn to start.",
  };
}

export function recordFindings(
  review: ReviewRecord,
  input: {
    reviewId: string;
    head: string;
    summary: string;
    findings: {
      priority: "P1" | "P2" | "P3";
      title: string;
      body: string;
      path: string;
      line: number;
    }[];
  },
): ReviewRecord {
  if (
    review.status !== "running" ||
    input.reviewId !== review.id ||
    input.head !== review.target.head
  )
    throw new Error("This result does not belong to the active review revision.");
  if (!input.summary.trim() || input.summary.length > 2000 || input.findings.length > 20)
    throw new Error("Record a summary and at most 20 findings.");
  const findings: Finding[] = input.findings.map((finding) => {
    if (
      !["P1", "P2", "P3"].includes(finding.priority) ||
      !relativeFile(finding.path) ||
      !review.target.files.includes(finding.path) ||
      !Number.isSafeInteger(finding.line) ||
      finding.line < 1 ||
      !finding.title.trim() ||
      finding.title.length > 160 ||
      !finding.body.trim() ||
      finding.body.length > 4000
    )
      throw new Error("A finding has an invalid priority, changed-file location, or explanation.");
    return { ...finding, id: randomUUID() };
  });
  return {
    ...review,
    summary: input.summary,
    findings,
    recorded: true,
    detail: "Findings recorded; Pi is finishing the review.",
  };
}

export function finishReview(
  review: ReviewRecord,
  outcome: "completed" | "error" | "aborted",
): ReviewRecord {
  const status =
    outcome === "error"
      ? "failed"
      : outcome === "aborted"
        ? "aborted"
        : review.recorded
          ? "completed"
          : "incomplete";
  return {
    ...review,
    status,
    finishedAt: Date.now(),
    detail:
      status === "incomplete"
        ? "Pi finished without recording structured findings. The conversation contains its response."
        : status === "completed"
          ? "Review completed by Pi."
          : `The Pi review ${status}. Recorded findings may be incomplete.`,
  };
}

export function prepareFix(
  review: ReviewRecord,
  target: ReviewTarget | null,
  findingId: string,
): FixDraft {
  const stale = staleReason(review, target);
  if (stale) throw new Error(stale);
  if (review.status !== "completed")
    throw new Error("Finish a complete review before preparing a fix.");
  const finding = review.findings.find((item) => item.id === findingId);
  if (!finding) throw new Error("The selected finding is no longer available.");
  return {
    title: `PR #${review.target.number}: ${finding.title}`.slice(0, 160),
    prompt: `Address this finding from a Pi review of ${review.target.url}.\nReviewed head: ${review.target.head}\nReview ID: ${review.id}\n\n[${finding.priority}] ${finding.title}\n${finding.path}:${finding.line}\n${finding.body}\n\nRecheck the finding against the current checkout before editing. Preserve existing local changes. Make a focused fix and run relevant checks.`,
    files: [{ path: finding.path, line: finding.line }],
  };
}

export function restoreRecord(
  entries: readonly { type: string; customType?: string; data?: unknown }[],
): ReviewRecord | null {
  let latest: ReviewRecord | null = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY || !validRecord(entry.data)) continue;
    latest = structuredClone(entry.data);
  }
  if (latest && busy(latest))
    latest = {
      ...latest,
      status: "interrupted",
      detail:
        "The previous review did not settle. Its outcome is unknown; start a new review explicitly.",
    };
  return latest;
}

function validRecord(value: unknown): value is ReviewRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<ReviewRecord>;
  const t = v.target;
  return (
    v.version === 1 &&
    typeof v.id === "string" &&
    v.id.length <= 80 &&
    typeof v.summary === "string" &&
    v.summary.length <= 2000 &&
    typeof v.detail === "string" &&
    typeof v.recorded === "boolean" &&
    typeof v.requestedAt === "number" &&
    (v.finishedAt === null || typeof v.finishedAt === "number") &&
    [
      "requested",
      "running",
      "completed",
      "incomplete",
      "failed",
      "aborted",
      "interrupted",
    ].includes(v.status ?? "") &&
    !!t &&
    typeof t.checkout === "string" &&
    typeof t.repository === "string" &&
    typeof t.number === "number" &&
    typeof t.url === "string" &&
    typeof t.title === "string" &&
    typeof t.branch === "string" &&
    [t.head, t.base, t.mergeBase, t.localHead].every(
      (sha) => typeof sha === "string" && /^[a-f0-9]{40,64}$/.test(sha),
    ) &&
    typeof t.dirty === "boolean" &&
    Array.isArray(t.files) &&
    t.files.length <= 200 &&
    t.files.every((file) => typeof file === "string" && relativeFile(file)) &&
    Array.isArray(v.findings) &&
    v.findings.length <= 20 &&
    v.findings.every(
      (f) =>
        !!f &&
        typeof f.id === "string" &&
        ["P1", "P2", "P3"].includes(f.priority) &&
        typeof f.title === "string" &&
        typeof f.body === "string" &&
        typeof f.path === "string" &&
        t.files.includes(f.path) &&
        Number.isSafeInteger(f.line) &&
        f.line > 0,
    )
  );
}
