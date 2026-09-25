import type { SessionRef } from "@pi-gui/session-driver/types";

/** The live checkout scopes: HEAD→working tree, HEAD→index, and index→working tree. */
export type WorkingReviewScope =
  { readonly kind: "uncommitted" } | { readonly kind: "staged" } | { readonly kind: "unstaged" };

export type ReviewScope =
  | WorkingReviewScope
  | { readonly kind: "branch"; readonly baseRef?: string }
  | { readonly kind: "turn"; readonly checkpointId?: string };

export interface ReviewCoverage {
  readonly state: "complete" | "partial";
  readonly notes: readonly string[];
}

export interface ReviewIssue {
  readonly state: "stale" | "unavailable" | "failed";
  readonly code: string;
  readonly message: string;
}

export type ReviewFileStatus =
  | "added"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "typechanged";

export interface ReviewLineCounts {
  readonly added: number;
  readonly removed: number;
}

export interface ReviewFileEntry {
  readonly id: string;
  readonly path: string;
  readonly previousPath?: string;
  readonly status: ReviewFileStatus;
  readonly hasStagedChanges: boolean;
  readonly hasUnstagedChanges: boolean;
  readonly conflicted: boolean;
  readonly reviewed: boolean;
  /** Changed line counts; null for binary files or when Git could not count them. */
  readonly lines: ReviewLineCounts | null;
}

export interface AvailableReview {
  readonly state: "available";
  readonly reviewId: string;
  /** Resolved base reference or checkpoint; a turn result always includes its checkpointId. */
  readonly scope: ReviewScope;
  readonly checkoutId: string;
  readonly baseLabel: string;
  readonly headOid: string | null;
  readonly baseOid: string | null;
  readonly capturedAt?: string;
  readonly files: readonly ReviewFileEntry[];
  readonly coverage: ReviewCoverage;
}

export type ReviewResult = AvailableReview | ReviewIssue;

export type ReviewFileResult =
  | {
      readonly state: "available";
      readonly reviewId: string;
      readonly fileId: string;
      readonly patch: string;
      readonly summary?: string;
      readonly coverage: ReviewCoverage;
    }
  | ReviewIssue;

export interface GetReviewInput {
  readonly target: SessionRef;
  readonly checkoutId: string;
  readonly scope: ReviewScope;
}

export interface TurnChangesInput {
  readonly target: SessionRef;
}

export interface TurnChangedFile {
  readonly path: string;
  readonly previousPath?: string;
  /** Line counts; binary files have none. */
  readonly lines: ReviewLineCounts | null;
}

/** What one captured agent turn changed, anchored to that turn's transcript entries. */
export interface TurnChangeSummary {
  readonly checkpointId: string;
  readonly checkoutId: string;
  readonly entryIds: readonly string[];
  readonly files: readonly TurnChangedFile[];
}

export type TurnChangesResult =
  { readonly state: "available"; readonly turns: readonly TurnChangeSummary[] } | ReviewIssue;

export interface ReviewFileInput {
  readonly reviewId: string;
  readonly fileId: string;
}

export interface SetReviewFileReviewedInput extends ReviewFileInput {
  readonly reviewed: boolean;
}

export interface ChangeReviewFileStageInput extends ReviewFileInput {
  readonly action: "stage" | "unstage";
}

export type SetReviewFileReviewedResult =
  | {
      readonly state: "available";
      readonly reviewId: string;
      readonly fileId: string;
      readonly reviewed: boolean;
    }
  | ReviewIssue;

export type ChangeReviewFileStageResult = { readonly state: "applied" } | ReviewIssue;

export function isWorkingReviewScope(scope: ReviewScope): scope is WorkingReviewScope {
  return scope.kind === "uncommitted" || scope.kind === "staged" || scope.kind === "unstaged";
}

export function decodeReviewScope(value: unknown): ReviewScope {
  const scope = record(value, ["kind", "baseRef", "checkpointId"]);
  if (scope.kind === "uncommitted" || scope.kind === "staged" || scope.kind === "unstaged") {
    if (scope.baseRef !== undefined || scope.checkpointId !== undefined) fail("scope fields");
    return { kind: scope.kind };
  }
  if (scope.kind === "branch") {
    if (scope.checkpointId !== undefined) fail("branch checkpoint");
    return scope.baseRef === undefined
      ? { kind: "branch" }
      : { kind: "branch", baseRef: text(scope.baseRef, "baseRef") };
  }
  if (scope.kind === "turn") {
    if (scope.baseRef !== undefined) fail("turn base");
    return scope.checkpointId === undefined
      ? { kind: "turn" }
      : { kind: "turn", checkpointId: text(scope.checkpointId, "checkpointId") };
  }
  return fail("scope kind");
}

export function decodeGetReviewInput(value: unknown): GetReviewInput {
  const input = record(value, ["target", "checkoutId", "scope"]);
  return {
    target: sessionTarget(input.target),
    checkoutId: text(input.checkoutId, "checkoutId"),
    scope: decodeReviewScope(input.scope),
  };
}

export function decodeTurnChangesInput(value: unknown): TurnChangesInput {
  return { target: sessionTarget(record(value, ["target"]).target) };
}

export function decodeReviewFileInput(value: unknown): ReviewFileInput {
  return fileInput(record(value, ["reviewId", "fileId"]));
}

export function decodeSetReviewFileReviewedInput(value: unknown): SetReviewFileReviewedInput {
  const input = record(value, ["reviewId", "fileId", "reviewed"]);
  if (typeof input.reviewed !== "boolean") fail("reviewed");
  return { ...fileInput(input), reviewed: input.reviewed };
}

export function decodeChangeReviewFileStageInput(value: unknown): ChangeReviewFileStageInput {
  const input = record(value, ["reviewId", "fileId", "action"]);
  if (input.action !== "stage" && input.action !== "unstage") fail("stage action");
  return { ...fileInput(input), action: input.action };
}

function fileInput(input: Record<string, unknown>): ReviewFileInput {
  return {
    reviewId: text(input.reviewId, "reviewId"),
    fileId: text(input.fileId, "fileId"),
  };
}

function sessionTarget(value: unknown): SessionRef {
  const target = record(value, ["workspaceId", "sessionId"]);
  return {
    workspaceId: text(target.workspaceId, "target.workspaceId"),
    sessionId: text(target.sessionId, "target.sessionId"),
  };
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    return fail("object fields");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0")) {
    return fail(label);
  }
  return value;
}

function fail(label: string): never {
  throw new Error(`Invalid review request: ${label}`);
}
