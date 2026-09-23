import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type {
  ChangeReviewFileStageInput,
  ChangeReviewFileStageResult,
  GetReviewInput,
  ReviewCoverage,
  ReviewFileInput,
  ReviewFileResult,
  ReviewIssue,
  ReviewResult,
  ResolveTurnReviewInput,
  ResolveTurnReviewResult,
  SetReviewFileReviewedInput,
  SetReviewFileReviewedResult,
} from "../../contracts/review";
import {
  changeGitReviewFileStage,
  checkGitReviewFileCurrent,
  createGitReview,
  readGitReviewFile,
  type GitReviewFile,
  type GitReviewScope,
  type GitReviewSnapshot,
} from "../platform/files/git-review";
import { ReviewedStore } from "./reviewed-store";

export interface ReviewCheckpoint {
  readonly state: "available";
  readonly checkpointId: string;
  readonly checkoutId: string;
  /** App-owned bare repository containing the captured trees. */
  readonly repositoryPath: string;
  readonly beforeTreeOid: string;
  readonly afterTreeOid: string;
  readonly capturedAt: string;
  readonly coverage: ReviewCoverage;
}

export interface ReviewCheckpointSource {
  resolve(input: {
    readonly target: SessionRef;
    readonly checkoutId: string;
    readonly checkpointId?: string;
  }): Promise<ReviewCheckpoint | ReviewIssue>;
  resolveTurn?(input: ResolveTurnReviewInput): Promise<ResolveTurnReviewResult>;
}

export interface ReviewOwnerOptions {
  readonly userDataDir: string;
  readonly resolveCheckoutPath: (checkoutId: string) => string | undefined;
  readonly validateTask: (target: SessionRef) => boolean;
  readonly checkpoints?: ReviewCheckpointSource;
}

interface OwnedReview {
  readonly id: string;
  readonly target: SessionRef;
  readonly checkoutId: string;
  readonly checkoutPath: string | null;
  readonly snapshot: GitReviewSnapshot;
}

const MAX_RETAINED_REVIEWS = 16;

/** Main owns comparison identities and reviewed state; the Git adapter owns Git semantics. */
export class ReviewOwner {
  private readonly reviews = new Map<string, OwnedReview>();
  private readonly reviewed: ReviewedStore;
  private readonly mutations = new Map<string, Promise<void>>();

  constructor(private readonly options: ReviewOwnerOptions) {
    this.reviewed = new ReviewedStore(options.userDataDir);
  }

  async resolveTurnReview(input: ResolveTurnReviewInput): Promise<ResolveTurnReviewResult> {
    try {
      if (!this.options.validateTask(input.target)) {
        return unavailable("task-unavailable", "This task is unavailable.");
      }
      if (!this.options.checkpoints?.resolveTurn) {
        return unavailable("checkpoint-unavailable", "No capture exists for this message.");
      }
      return await this.options.checkpoints.resolveTurn(input);
    } catch (error: unknown) {
      return failed(error);
    }
  }

  async getReview(input: GetReviewInput): Promise<ReviewResult> {
    try {
      if (!this.options.validateTask(input.target)) {
        return unavailable("task-unavailable", "This task is unavailable.");
      }
      let checkoutPath: string | null = null;
      let gitPath: string;
      let scope: GitReviewScope;
      let capturedAt: string | undefined;
      if (input.scope.kind === "turn") {
        if (!this.options.checkpoints) {
          return unavailable(
            "checkpoint-unavailable",
            "No captured turn is available for this task.",
          );
        }
        const checkpoint = await this.options.checkpoints.resolve({
          target: input.target,
          checkoutId: input.checkoutId,
          ...(input.scope.checkpointId ? { checkpointId: input.scope.checkpointId } : {}),
        });
        if (checkpoint.state !== "available") return checkpoint;
        if (checkpoint.checkoutId !== input.checkoutId) {
          return unavailable(
            "checkpoint-checkout-mismatch",
            "The captured turn belongs to another checkout.",
          );
        }
        gitPath = checkpoint.repositoryPath;
        capturedAt = checkpoint.capturedAt;
        scope = {
          kind: "turn",
          checkpointId: checkpoint.checkpointId,
          beforeTreeOid: checkpoint.beforeTreeOid,
          afterTreeOid: checkpoint.afterTreeOid,
          coverage: checkpoint.coverage,
        };
      } else {
        const currentPath = await this.checkoutPath(input.target, input.checkoutId);
        if (typeof currentPath !== "string") return currentPath;
        checkoutPath = currentPath;
        gitPath = currentPath;
        scope = input.scope;
      }
      const snapshot = await createGitReview(gitPath, scope);
      if (snapshot.state !== "available") return snapshot;
      const marks = await this.reviewed.snapshot();
      const owned: OwnedReview = {
        id: randomUUID(),
        target: { ...input.target },
        checkoutId: input.checkoutId,
        checkoutPath,
        snapshot,
      };
      this.remember(owned);
      return {
        state: "available",
        reviewId: owned.id,
        scope: snapshot.scope,
        checkoutId: input.checkoutId,
        baseLabel: snapshot.baseLabel,
        headOid: snapshot.headOid,
        baseOid: snapshot.baseOid,
        ...(capturedAt ? { capturedAt } : {}),
        coverage: snapshot.coverage,
        files: snapshot.files.map((file) => ({
          id: file.id,
          path: file.path,
          ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
          status: file.status,
          hasStagedChanges: file.hasStagedChanges,
          hasUnstagedChanges: file.hasUnstagedChanges,
          conflicted: file.conflicted,
          reviewed: marks.has(markKey(owned, file)),
        })),
      };
    } catch (error: unknown) {
      return failed(error);
    }
  }

  async getReviewFile(input: ReviewFileInput): Promise<ReviewFileResult> {
    try {
      const resolved = await this.resolveFile(input);
      if (isIssue(resolved)) return resolved;
      const result = await readGitReviewFile(resolved.review.snapshot, input.fileId);
      return result.state === "available"
        ? { ...result, reviewId: input.reviewId, fileId: input.fileId }
        : result;
    } catch (error: unknown) {
      return failed(error);
    }
  }

  async setReviewFileReviewed(
    input: SetReviewFileReviewedInput,
  ): Promise<SetReviewFileReviewedResult> {
    try {
      const resolved = await this.resolveFile(input);
      if (isIssue(resolved)) return resolved;
      const issue = await checkGitReviewFileCurrent(resolved.review.snapshot, input.fileId);
      if (issue) return issue;
      await this.reviewed.set(markKey(resolved.review, resolved.file), input.reviewed);
      return {
        state: "available",
        reviewId: input.reviewId,
        fileId: input.fileId,
        reviewed: input.reviewed,
      };
    } catch (error: unknown) {
      return failed(error);
    }
  }

  async changeReviewFileStage(
    input: ChangeReviewFileStageInput,
  ): Promise<ChangeReviewFileStageResult> {
    try {
      const resolved = await this.resolveFile(input);
      if (isIssue(resolved)) return resolved;
      if (
        resolved.review.snapshot.scope.kind !== "uncommitted" ||
        resolved.review.checkoutPath === null
      ) {
        return unavailable(
          "read-only-comparison",
          "Staging is available only for Uncommitted changes.",
        );
      }
      return await this.withMutation(resolved.review.checkoutPath, async () => {
        const current = await this.resolveFile(input);
        if (isIssue(current)) return current;
        return changeGitReviewFileStage(current.review.snapshot, input.fileId, input.action);
      });
    } catch (error: unknown) {
      return failed(error);
    }
  }

  private async resolveFile(
    input: ReviewFileInput,
  ): Promise<{ readonly review: OwnedReview; readonly file: GitReviewFile } | ReviewIssue> {
    const review = this.reviews.get(input.reviewId);
    if (!review)
      return unavailable(
        "review-expired",
        "This comparison expired. Refresh to review current changes.",
      );
    if (!this.options.validateTask(review.target)) {
      return unavailable("task-unavailable", "This task is unavailable.");
    }
    if (review.snapshot.scope.kind !== "turn") {
      const currentPath = await this.checkoutPath(review.target, review.checkoutId);
      if (typeof currentPath !== "string") return currentPath;
      if (currentPath !== review.checkoutPath) {
        return {
          state: "stale",
          code: "checkout-changed",
          message: "The checkout moved. Refresh this comparison.",
        };
      }
    }
    const file = review.snapshot.files.find((entry) => entry.id === input.fileId);
    return file
      ? { review, file }
      : unavailable("review-file-unavailable", "This file is not part of the selected comparison.");
  }

  private async checkoutPath(
    target: SessionRef,
    checkoutId: string,
  ): Promise<string | ReviewIssue> {
    if (!this.options.validateTask(target))
      return unavailable("task-unavailable", "This task is unavailable.");
    const path = this.options.resolveCheckoutPath(checkoutId);
    if (!path) return unavailable("checkout-unavailable", "This checkout is unavailable.");
    try {
      return await realpath(path);
    } catch {
      return unavailable(
        "checkout-unavailable",
        "This checkout no longer exists or cannot be read.",
      );
    }
  }

  private remember(review: OwnedReview): void {
    this.reviews.set(review.id, review);
    while (this.reviews.size > MAX_RETAINED_REVIEWS) {
      const oldest = this.reviews.keys().next().value;
      if (oldest === undefined) break;
      this.reviews.delete(oldest);
    }
  }

  private async withMutation<T>(checkoutPath: string, action: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(checkoutPath) ?? Promise.resolve();
    const next = previous.then(action);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.mutations.set(checkoutPath, settled);
    try {
      return await next;
    } finally {
      if (this.mutations.get(checkoutPath) === settled) this.mutations.delete(checkoutPath);
    }
  }
}

function markKey(review: OwnedReview, file: GitReviewFile): string {
  const scope = review.snapshot.scope;
  return createHash("sha256")
    .update(
      JSON.stringify([
        review.target.workspaceId,
        review.target.sessionId,
        review.checkoutId,
        review.checkoutPath,
        scope.kind,
        scope.kind === "branch" ? scope.baseRef : scope.kind === "turn" ? scope.checkpointId : null,
        file.path,
        file.previousPath,
        file.contentFingerprint,
      ]),
    )
    .digest("hex");
}

function isIssue(value: { readonly review: OwnedReview } | ReviewIssue): value is ReviewIssue {
  return "state" in value;
}

function unavailable(code: string, message: string): ReviewIssue {
  return { state: "unavailable", code, message };
}

function failed(error: unknown): ReviewIssue {
  return {
    state: "failed",
    code: "review-failed",
    message: error instanceof Error ? error.message : String(error),
  };
}
