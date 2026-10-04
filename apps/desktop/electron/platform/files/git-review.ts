import type {
  ChangeReviewFileStageResult,
  ReviewCoverage,
  ReviewFileEntry,
  ReviewIssue,
  ReviewScope,
  TurnChangedFile,
} from "../../../contracts/review";
import { coreMethods } from "../../../core-process/protocol";
import type { RpcPeer } from "../../../rpc/rpc-peer";

/**
 * Review comparisons, run by the Rust core (`crates/pi-gui-core/src/git/review.rs`). The
 * caller keeps each snapshot and passes it back for every file call; the core checks the
 * file's fingerprint against the checkout before reading, marking or staging it.
 */
export interface GitReviewLimits {
  /** Output cap for one Git listing; larger output makes the review unavailable. */
  readonly maxGitBytes: number;
}

export type GitReviewScope =
  | Exclude<ReviewScope, { readonly kind: "turn" }>
  | {
      readonly kind: "turn";
      readonly checkpointId: string;
      readonly beforeTreeOid: string;
      readonly afterTreeOid: string;
      readonly coverage?: ReviewCoverage;
    };

interface BlobRef {
  readonly mode: string;
  readonly oid: string;
  readonly stage?: number;
}

interface FileSource {
  readonly base?: BlobRef;
  readonly head?: BlobRef;
  readonly index: readonly BlobRef[];
  readonly working?: { readonly mode: string; readonly digest: string; readonly note?: string };
  readonly statusRecords: readonly string[];
}

export interface GitReviewFile extends Omit<ReviewFileEntry, "reviewed"> {
  /** Everything the comparison read, including the index; any change makes actions stale. */
  readonly fingerprint: string;
  /** The reviewed content only. Staging moves it into the index without changing it. */
  readonly contentFingerprint: string;
  readonly source: FileSource;
}

export interface GitReviewSnapshot {
  readonly state: "available";
  readonly checkoutPath: string;
  readonly scope: ReviewScope;
  readonly baseLabel: string;
  readonly headOid: string | null;
  readonly baseOid: string | null;
  readonly coverage: ReviewCoverage;
  readonly files: readonly GitReviewFile[];
}

export interface GitReviewFileContent {
  readonly state: "available";
  readonly patch: string;
  readonly coverage: ReviewCoverage;
  readonly summary?: string;
}

export interface GitReview {
  createGitReview(
    checkoutPath: string,
    scope: GitReviewScope,
    limits?: Partial<GitReviewLimits>,
  ): Promise<GitReviewSnapshot | ReviewIssue>;
  checkGitReviewFileCurrent(
    snapshot: GitReviewSnapshot,
    fileId: string,
  ): Promise<ReviewIssue | null>;
  readGitReviewFile(
    snapshot: GitReviewSnapshot,
    fileId: string,
  ): Promise<GitReviewFileContent | ReviewIssue>;
  changeGitReviewFileStage(
    snapshot: GitReviewSnapshot,
    fileId: string,
    action: "stage" | "unstage",
  ): Promise<ChangeReviewFileStageResult>;
  /** Per-file line counts between two captured trees, in Git's path order. */
  summarizeGitTreeChanges(
    repositoryPath: string,
    beforeTreeOid: string,
    afterTreeOid: string,
  ): Promise<TurnChangedFile[]>;
}

export function gitReviewClient(core: RpcPeer): GitReview {
  const call = async <T>(method: string, params: unknown) =>
    (await core.request(method, params)) as T;
  return {
    createGitReview: (checkoutPath, scope, limits = {}) =>
      call(coreMethods.reviewCreate, { checkoutPath, scope, limits }),
    checkGitReviewFileCurrent: (snapshot, fileId) =>
      call(coreMethods.reviewCheckFile, { snapshot, fileId }),
    readGitReviewFile: (snapshot, fileId) => call(coreMethods.reviewReadFile, { snapshot, fileId }),
    changeGitReviewFileStage: (snapshot, fileId, action) =>
      call(coreMethods.reviewChangeStage, { snapshot, fileId, action }),
    summarizeGitTreeChanges: (repositoryPath, beforeTreeOid, afterTreeOid) =>
      call(coreMethods.reviewTreeChanges, { repositoryPath, beforeTreeOid, afterTreeOid }),
  };
}
