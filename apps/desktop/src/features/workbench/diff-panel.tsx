import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DiffPanelFileRequest,
  DiffPanelSelection,
  FileWorkbenchContext,
} from "./diff-panel-types";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type {
  AvailableReview,
  ReviewCoverage,
  ReviewFileEntry,
  ReviewFileResult,
  ReviewIssue,
  ReviewResult,
  ReviewScope,
} from "../../../contracts/review";
import { isWorkingReviewScope, reviewStageActions } from "../../../contracts/review";
import { InlineDiff } from "../../ui/diff-inline";
import { ChevronDownIcon, FileIcon, MoreIcon, RefreshIcon, SidePanelIcon } from "../../ui/icons";
import { extensionToLanguage } from "../../ui/syntax-highlight";
import { formatPathForDisplay, ReviewFileTree, reviewTreeOrder } from "./review-file-tree";
import { ReviewMenu } from "./review-menu";

interface DiffPanelProps {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly api: PiDesktopApi;
  readonly sessionStatus: string | undefined;
  readonly fileRequest?: DiffPanelFileRequest | null;
  readonly contexts: readonly FileWorkbenchContext[];
  readonly selection: DiffPanelSelection;
  readonly onSelectionChange: (selection: DiffPanelSelection) => void;
  readonly onOpenFile: (file: {
    readonly workspaceId: string;
    readonly path: string;
  }) => void | Promise<void>;
}

export function DiffPanel({
  workspaceId,
  sessionId,
  api,
  sessionStatus,
  fileRequest,
  contexts,
  selection,
  onSelectionChange,
  onOpenFile,
}: DiffPanelProps) {
  const scopeKey = JSON.stringify(selection.scope);
  const requestedScope = useMemo(() => selection.scope, [scopeKey]);
  const queryKey = JSON.stringify([workspaceId, sessionId, selection.workspaceId, scopeKey]);
  const activeQueryKey = useRef(queryKey);
  activeQueryKey.current = queryKey;
  const [loaded, setLoaded] = useState<{
    readonly queryKey: string;
    readonly result: ReviewResult;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileResult, setFileResult] = useState<ReviewFileResult | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [actionIssue, setActionIssue] = useState<ReviewIssue | null>(null);
  const [busyFiles, setBusyFiles] = useState<ReadonlySet<string>>(new Set());
  const [baseDraft, setBaseDraft] = useState(
    selection.scope.kind === "branch" ? (selection.scope.baseRef ?? "") : "",
  );
  const requestNonce = useRef(0);
  const fileNonce = useRef(0);
  const [treeVisible, setTreeVisible] = useReviewTreeVisible();
  const selectedCheckout = contexts.find(
    (context) => context.workspace.id === selection.workspaceId,
  );
  const checkoutAvailable = selectedCheckout !== undefined;
  const result = loaded?.queryKey === queryKey ? loaded.result : null;
  const review = result?.state === "available" ? result : null;
  const reviewRef = useRef(review);
  reviewRef.current = review;
  // Without a chosen file in this comparison (none yet, or it was staged away or reverted),
  // the diff shows the first file in the tree, as Codex does, without saving that default.
  // A quiet refresh holds whichever file was on screen so new files don't take its place.
  const [heldPath, setHeldPath] = useState<{ readonly queryKey: string; readonly path: string }>();
  const shownFallback = heldPath?.queryKey === queryKey ? heldPath.path : null;
  useEffect(() => setHeldPath(undefined), [selection.selectedPath]);
  const selectedFile = useMemo(
    () => (review ? pickReviewFile(review, [selection.selectedPath, shownFallback]) : undefined),
    [review, selection.selectedPath, shownFallback],
  );
  const stale = actionIssue?.state === "stale" || fileResult?.state === "stale";

  useEffect(() => {
    setBaseDraft(requestedScope.kind === "branch" ? (requestedScope.baseRef ?? "") : "");
  }, [requestedScope]);

  const refresh = useCallback(() => {
    const nonce = ++requestNonce.current;
    setHeldPath(undefined);
    fileNonce.current += 1;
    setLoading(true);
    setFileResult(null);
    setFileLoading(false);
    setActionIssue(null);
    setBusyFiles(new Set());
    if (!checkoutAvailable) {
      setLoaded({
        queryKey,
        result: {
          state: "unavailable",
          code: "checkout-unavailable",
          message: "The selected checkout is unavailable.",
        },
      });
      setLoading(false);
      return;
    }
    void api
      .getReview({
        target: { workspaceId, sessionId },
        checkoutId: selection.workspaceId,
        scope: requestedScope,
      })
      .then(
        (next) => {
          if (requestNonce.current !== nonce || activeQueryKey.current !== queryKey) return;
          setLoaded({ queryKey, result: next });
          setLoading(false);
        },
        (error: unknown) => {
          if (requestNonce.current !== nonce || activeQueryKey.current !== queryKey) return;
          setLoaded({
            queryKey,
            result: { state: "failed", code: "review-read-failed", message: errorMessage(error) },
          });
          setLoading(false);
        },
      );
  }, [
    api,
    checkoutAvailable,
    queryKey,
    requestedScope,
    selection.workspaceId,
    sessionId,
    workspaceId,
  ]);

  useEffect(() => {
    refresh();
    return () => {
      requestNonce.current += 1;
      fileNonce.current += 1;
    };
  }, [refresh]);

  const previousRunStatus = useRef(sessionStatus);
  useEffect(() => {
    const previous = previousRunStatus.current;
    previousRunStatus.current = sessionStatus;
    if (
      previous === "running" &&
      sessionStatus !== "running" &&
      (isWorkingReviewScope(requestedScope) ||
        (requestedScope.kind === "turn" && !requestedScope.checkpointId))
    )
      refresh();
  }, [refresh, requestedScope, sessionStatus]);

  // A quiet refresh swaps in the new comparison and the shown file's diff together, so the
  // panel never blanks. It stands aside while a load or a file action is in flight.
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const busyRef = useRef(busyFiles);
  busyRef.current = busyFiles;
  const selectedPathRef = useRef(selection.selectedPath);
  selectedPathRef.current = selection.selectedPath;
  const shownPathRef = useRef(selectedFile?.path);
  shownPathRef.current = selectedFile?.path;
  const fileRequestNonceRef = useRef(fileRequest?.nonce);
  fileRequestNonceRef.current = fileRequest?.nonce;
  const prefetchedFileKey = useRef<string | null>(null);
  const quietInFlight = useRef(false);
  const actionCount = useRef(0);
  const refreshQuietly = useCallback(() => {
    if (!checkoutAvailable || quietInFlight.current || loadingRef.current) return;
    if (busyRef.current.size > 0) return;
    const nonce = ++requestNonce.current;
    const actionsAtStart = actionCount.current;
    // An action started meanwhile (such as a reviewed mark) may be newer than this read.
    const current = () =>
      requestNonce.current === nonce &&
      activeQueryKey.current === queryKey &&
      actionCount.current === actionsAtStart;
    quietInFlight.current = true;
    void (async () => {
      const next = await api.getReview({
        target: { workspaceId, sessionId },
        checkoutId: selection.workspaceId,
        scope: requestedScope,
      });
      const shown =
        next.state === "available"
          ? pickReviewFile(next, [selectedPathRef.current, shownPathRef.current])
          : undefined;
      const file =
        next.state === "available" && shown
          ? await api.getReviewFile({ reviewId: next.reviewId, fileId: shown.id })
          : null;
      if (!current()) return;
      fileNonce.current += 1;
      prefetchedFileKey.current =
        next.state === "available" && shown
          ? fileKey(next.reviewId, shown.id, fileRequestNonceRef.current)
          : null;
      setLoaded({ queryKey, result: next });
      if (shown && shown.path !== selectedPathRef.current)
        setHeldPath({ queryKey, path: shown.path });
      setFileResult(file);
      setFileLoading(false);
      setActionIssue((issue) =>
        file?.state === "stale" ? file : issue?.state === "stale" ? null : issue,
      );
    })()
      .catch(() => {
        // The comparison on screen stays; the Refresh button reports errors.
      })
      .finally(() => {
        quietInFlight.current = false;
      });
  }, [
    api,
    checkoutAvailable,
    queryKey,
    requestedScope,
    selection.workspaceId,
    sessionId,
    workspaceId,
  ]);
  // The repository may have changed in another editor or terminal while pi-gui was in the
  // background. The integrated terminal shares this side panel, so returning to Review reloads it.
  const refreshOnFocus = isWorkingReviewScope(requestedScope) || requestedScope.kind === "branch";
  useEffect(() => {
    if (refreshOnFocus) return api.onWindowFocused(refreshQuietly);
  }, [api, refreshOnFocus, refreshQuietly]);

  useEffect(() => {
    const key =
      review && selectedFile ? fileKey(review.reviewId, selectedFile.id, fileRequest?.nonce) : null;
    const prefetched = key !== null && key === prefetchedFileKey.current;
    prefetchedFileKey.current = null;
    if (prefetched && !loading) return;
    const nonce = ++fileNonce.current;
    setFileResult(null);
    setFileLoading(false);
    if (!review || !selectedFile || loading) return;
    setFileLoading(true);
    void api.getReviewFile({ reviewId: review.reviewId, fileId: selectedFile.id }).then(
      (next) => {
        if (fileNonce.current !== nonce || activeQueryKey.current !== queryKey) return;
        setFileResult(next);
        if (next.state === "stale") setActionIssue(next);
        setFileLoading(false);
      },
      (error: unknown) => {
        if (fileNonce.current !== nonce || activeQueryKey.current !== queryKey) return;
        setFileResult({
          state: "failed",
          code: "review-file-read-failed",
          message: errorMessage(error),
        });
        setFileLoading(false);
      },
    );
    return () => {
      fileNonce.current += 1;
    };
  }, [api, loading, queryKey, review?.reviewId, selectedFile?.id, fileRequest?.nonce]);

  const setBusy = (fileId: string, busy: boolean) => {
    if (busy) actionCount.current += 1;
    setBusyFiles((previous) => {
      const next = new Set(previous);
      if (busy) next.add(fileId);
      else next.delete(fileId);
      return next;
    });
  };
  const stillShowing = (comparison: AvailableReview, nonce: number) =>
    requestNonce.current === nonce &&
    activeQueryKey.current === queryKey &&
    reviewRef.current?.reviewId === comparison.reviewId;

  const markReviewed = (comparison: AvailableReview, file: ReviewFileEntry) => {
    const nonce = requestNonce.current;
    setBusy(file.id, true);
    void api
      .setReviewFileReviewed({
        reviewId: comparison.reviewId,
        fileId: file.id,
        reviewed: !file.reviewed,
      })
      .then(
        (next) => {
          if (!stillShowing(comparison, nonce)) return;
          if (next.state !== "available") {
            setActionIssue(next);
            return;
          }
          setLoaded((current) =>
            current?.result.state === "available" && current.result.reviewId === next.reviewId
              ? {
                  ...current,
                  result: {
                    ...current.result,
                    files: current.result.files.map((entry) =>
                      entry.id === next.fileId ? { ...entry, reviewed: next.reviewed } : entry,
                    ),
                  },
                }
              : current,
          );
        },
        (error: unknown) => {
          if (stillShowing(comparison, nonce))
            setActionIssue({
              state: "failed",
              code: "review-mark-failed",
              message: errorMessage(error),
            });
        },
      )
      .finally(() => {
        if (stillShowing(comparison, nonce)) setBusy(file.id, false);
      });
  };

  const stageFile = (
    comparison: AvailableReview,
    file: ReviewFileEntry,
    action: "stage" | "unstage",
  ) => {
    const nonce = requestNonce.current;
    setBusy(file.id, true);
    void api
      .changeReviewFileStage({ reviewId: comparison.reviewId, fileId: file.id, action })
      .then(
        (next) => {
          if (!stillShowing(comparison, nonce)) return;
          if (next.state === "applied") refresh();
          else setActionIssue(next);
        },
        (error: unknown) => {
          if (stillShowing(comparison, nonce))
            setActionIssue({
              state: "failed",
              code: "review-stage-failed",
              message: errorMessage(error),
            });
        },
      )
      .finally(() => {
        if (stillShowing(comparison, nonce)) setBusy(file.id, false);
      });
  };

  const chooseScope = (id: string) => {
    if (id === "selected-turn") return;
    const scope: ReviewScope =
      id === "branch" || id === "turn" || id === "staged" || id === "unstaged"
        ? { kind: id }
        : { kind: "uncommitted" };
    onSelectionChange({ ...selection, selectedPath: null, scope });
  };
  const openCurrentFile = (comparison: AvailableReview, file: ReviewFileEntry) => {
    const nonce = requestNonce.current;
    const reportError = (error: unknown) => {
      if (stillShowing(comparison, nonce))
        setActionIssue({
          state: "failed",
          code: "review-open-file-failed",
          message: errorMessage(error),
        });
    };
    try {
      void Promise.resolve(
        onOpenFile({ workspaceId: comparison.checkoutId, path: file.path }),
      ).catch(reportError);
    } catch (error: unknown) {
      reportError(error);
    }
  };
  const selectedScope =
    requestedScope.kind === "turn" && requestedScope.checkpointId
      ? "selected-turn"
      : requestedScope.kind;
  const totals = review && !loading ? lineTotals(review.files) : null;
  const displayedFileResult =
    fileResult?.state === "available" &&
    (fileResult.reviewId !== review?.reviewId || fileResult.fileId !== selectedFile?.id)
      ? null
      : fileResult;
  const comparisonDetails =
    review && !loading
      ? [
          review.baseLabel,
          ...(review.headOid ? [`HEAD ${review.headOid.slice(0, 8)}`] : []),
          ...(review.capturedAt ? [`Captured ${formatCaptureTime(review.capturedAt)}`] : []),
        ]
      : [];

  return (
    <section className="side-panel diff-panel review-panel" aria-label="Review">
      <div className="review-panel__toolbar">
        <ReviewMenu
          label="Review scope"
          value={SCOPE_LABELS[selectedScope]}
          buttonClassName="review-panel__scope"
          buttonContent={<ChevronDownIcon />}
          align="start"
          options={SCOPE_OPTIONS.filter(
            (option) => option.id !== "selected-turn" || selectedScope === "selected-turn",
          ).map((option) => ({ ...option, checked: option.id === selectedScope }))}
          onSelect={chooseScope}
        />
        {totals ? (
          <span className="review-panel__totals" data-testid="review-line-totals">
            <span className="review-panel__added">+{totals.added}</span>
            <span className="review-panel__removed">-{totals.removed}</span>
          </span>
        ) : null}
        <span className="review-panel__toolbar-spacer" />
        <button
          className="icon-button review-panel__tool"
          type="button"
          onClick={refresh}
          aria-label="Refresh"
          title="Refresh comparison"
          disabled={loading}
        >
          <RefreshIcon />
        </button>
        <ReviewMenu
          label="Review options"
          buttonClassName="icon-button review-panel__tool"
          buttonContent={<MoreIcon />}
          align="end"
          details={comparisonDetails}
          options={[
            ...(!selectedCheckout
              ? [{ id: selection.workspaceId, label: "Unavailable checkout", checked: true }]
              : []),
            ...contexts.map((context) => ({
              id: context.workspace.id,
              label: `${context.role === "thread" ? "Current task · " : ""}${
                context.worktree?.branchName ??
                context.workspace.branchName ??
                context.workspace.name
              }`,
              checked: context.workspace.id === selection.workspaceId,
            })),
          ]}
          onSelect={(checkoutId) => {
            if (checkoutId === selection.workspaceId) return;
            onSelectionChange({
              workspaceId: checkoutId,
              selectedPath: null,
              scope: requestedScope.kind === "turn" ? { kind: "uncommitted" } : requestedScope,
            });
          }}
        />
        <button
          className={`icon-button review-panel__tool${treeVisible ? " review-panel__tool--active" : ""}`}
          type="button"
          onClick={() => setTreeVisible(!treeVisible)}
          aria-label={treeVisible ? "Hide file tree" : "Show file tree"}
          aria-pressed={treeVisible}
          title={treeVisible ? "Hide file tree" : "Show file tree"}
        >
          <SidePanelIcon />
        </button>
      </div>
      {requestedScope.kind === "branch" ? (
        <form
          className="review-panel__base"
          onSubmit={(event) => {
            event.preventDefault();
            const baseRef = baseDraft.trim();
            if (baseRef === (requestedScope.baseRef ?? "")) refresh();
            else
              onSelectionChange({
                ...selection,
                selectedPath: null,
                scope: baseRef ? { kind: "branch", baseRef } : { kind: "branch" },
              });
          }}
        >
          <label htmlFor="review-base-ref">Base</label>
          <input
            id="review-base-ref"
            aria-label="Base branch"
            value={baseDraft}
            onChange={(event) => setBaseDraft(event.target.value)}
            placeholder={
              review?.scope.kind === "branch"
                ? (review.scope.baseRef ?? "Repository default")
                : "Repository default"
            }
          />
          <button type="submit" className="button" disabled={loading}>
            Compare
          </button>
        </form>
      ) : null}
      {actionIssue ? <ReviewIssueBanner issue={actionIssue} onRefresh={refresh} /> : null}
      {review && !loading ? <CoverageNotice coverage={review.coverage} /> : null}
      <div className={`review-panel__body${treeVisible ? "" : " review-panel__body--no-tree"}`}>
        <div className="diff-panel__viewer review-panel__viewer">
          {loading || !result ? (
            <div className="diff-panel__empty" role="status">
              Loading comparison…
            </div>
          ) : result.state !== "available" ? (
            <div
              className="diff-panel__empty diff-panel__unavailable"
              data-testid="changed-files-unavailable"
              role="status"
            >
              <p>{result.message}</p>
              <button className="button" type="button" onClick={refresh}>
                Retry
              </button>
            </div>
          ) : result.files.length === 0 ? (
            <div className="diff-panel__empty">
              {result.coverage.state === "partial"
                ? "No changes in the captured files."
                : "No changes"}
            </div>
          ) : !selectedFile ? (
            <div className="diff-panel__empty">
              This file is not part of the selected comparison.
            </div>
          ) : (
            <>
              <div className="review-panel__file-header">
                <span
                  className="review-panel__file-path"
                  title={formatPathForDisplay(selectedFile.path)}
                >
                  <PathLabel path={selectedFile.path} />
                </span>
                {selectedFile.lines ? (
                  <span className="review-panel__totals">
                    <span className="review-panel__added">+{selectedFile.lines.added}</span>
                    <span className="review-panel__removed">-{selectedFile.lines.removed}</span>
                  </span>
                ) : null}
                <span className="review-panel__toolbar-spacer" />
                {selectedFile.status !== "deleted" ? (
                  <button
                    className="icon-button review-panel__open-file"
                    type="button"
                    aria-label="Open in Files"
                    title="Open in Files"
                    onClick={() => openCurrentFile(result, selectedFile)}
                  >
                    <FileIcon />
                  </button>
                ) : null}
              </div>
              {selectedFile.previousPath ? (
                <div className="review-panel__rename">
                  Renamed from {formatPathForDisplay(selectedFile.previousPath)}
                </div>
              ) : null}
              <div className="review-panel__patches">
                {fileLoading ? (
                  <div className="diff-panel__empty">Loading diff…</div>
                ) : displayedFileResult?.state === "available" ? (
                  <>
                    <CoverageNotice coverage={displayedFileResult.coverage} />
                    {displayedFileResult.summary ? (
                      <p className="review-panel__summary">{displayedFileResult.summary}</p>
                    ) : null}
                    {displayedFileResult.patch ? (
                      <section className="review-panel__patch-section" aria-label="Diff">
                        <InlineDiff
                          diff={displayedFileResult.patch}
                          language={extensionToLanguage(selectedFile.path)}
                          unmodifiedGaps
                        />
                      </section>
                    ) : displayedFileResult.summary ? null : (
                      <p className="diff-panel__empty">No text diff is available for this file.</p>
                    )}
                  </>
                ) : displayedFileResult ? (
                  <ReviewIssueBanner issue={displayedFileResult} onRefresh={refresh} />
                ) : (
                  <div className="diff-panel__empty">Loading diff…</div>
                )}
              </div>
            </>
          )}
        </div>
        {treeVisible && review && !loading && review.files.length > 0 ? (
          <ReviewFileTree
            checkoutId={review.checkoutId}
            files={review.files}
            selectedPath={selectedFile?.path ?? null}
            stageActions={reviewStageActions(review.scope)}
            busyFiles={busyFiles}
            stale={stale}
            onSelect={(path) => onSelectionChange({ ...selection, selectedPath: path })}
            onToggleReviewed={(file) => markReviewed(review, file)}
            onStage={(file, action) => stageFile(review, file, action)}
          />
        ) : null}
      </div>
    </section>
  );
}

/** The first preferred path still in the comparison, else the first file in the tree. */
function pickReviewFile(
  review: AvailableReview,
  preferredPaths: readonly (string | null | undefined)[],
): ReviewFileEntry | undefined {
  for (const path of preferredPaths) {
    const file = path ? review.files.find((entry) => entry.path === path) : undefined;
    if (file) return file;
  }
  const first = reviewTreeOrder(review.files)[0];
  return review.files.find((file) => file.path === first);
}

function fileKey(reviewId: string, fileId: string, requestNonce: number | undefined): string {
  return JSON.stringify([reviewId, fileId, requestNonce ?? null]);
}

type ScopeOptionId = "turn" | "selected-turn" | "uncommitted" | "unstaged" | "staged" | "branch";

const SCOPE_LABELS: Record<ScopeOptionId, string> = {
  turn: "Last Turn",
  "selected-turn": "Selected Turn",
  uncommitted: "Uncommitted",
  unstaged: "Unstaged",
  staged: "Staged",
  branch: "Branch",
};

const SCOPE_OPTIONS: readonly {
  readonly id: ScopeOptionId;
  readonly label: string;
  readonly startsGroup?: boolean;
}[] = [
  { id: "turn", label: SCOPE_LABELS.turn },
  { id: "selected-turn", label: SCOPE_LABELS["selected-turn"] },
  { id: "uncommitted", label: SCOPE_LABELS.uncommitted, startsGroup: true },
  { id: "unstaged", label: SCOPE_LABELS.unstaged },
  { id: "staged", label: SCOPE_LABELS.staged },
  { id: "branch", label: SCOPE_LABELS.branch, startsGroup: true },
];

/** A path with its folder muted, like Codex's file header. */
function PathLabel({ path }: { readonly path: string }) {
  const display = formatPathForDisplay(path);
  if (display !== path) return <>{display}</>;
  const slash = path.lastIndexOf("/");
  return slash < 0 ? (
    <>{path}</>
  ) : (
    <>
      <span className="review-panel__file-dir">{path.slice(0, slash + 1)}</span>
      {path.slice(slash + 1)}
    </>
  );
}

function lineTotals(files: readonly ReviewFileEntry[]) {
  return files.reduce(
    (total, file) => ({
      added: total.added + (file.lines?.added ?? 0),
      removed: total.removed + (file.lines?.removed ?? 0),
    }),
    { added: 0, removed: 0 },
  );
}

function ReviewIssueBanner({
  issue,
  onRefresh,
}: {
  readonly issue: ReviewIssue;
  readonly onRefresh: () => void;
}) {
  return (
    <div
      className="review-panel__issue"
      data-testid={issue.state === "stale" ? "review-stale" : "review-issue"}
      role="status"
    >
      <p>{issue.message}</p>
      <button className="button" type="button" onClick={onRefresh}>
        {issue.state === "stale" ? "Refresh comparison" : "Retry"}
      </button>
    </div>
  );
}

function CoverageNotice({ coverage }: { readonly coverage: ReviewCoverage }) {
  if (coverage.state === "complete" && coverage.notes.length === 0) return null;
  return (
    <details className="review-panel__coverage" data-testid="review-coverage">
      <summary>
        {coverage.state === "partial" ? "Comparison has limits" : "Comparison details"}
      </summary>
      {coverage.notes.length ? (
        <ul>
          {coverage.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      ) : (
        <p>Some changes could not be included.</p>
      )}
    </details>
  );
}

function formatCaptureTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TREE_VISIBLE_KEY = "pi-gui.review-tree-visible";

/** Whether the changed-file tree shows beside the diff; a window preference like pane widths. */
function useReviewTreeVisible() {
  const [visible, setVisible] = useState(() => {
    try {
      return localStorage.getItem(TREE_VISIBLE_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const update = useCallback((next: boolean) => {
    setVisible(next);
    try {
      localStorage.setItem(TREE_VISIBLE_KEY, String(next));
    } catch {
      // The toggle still applies for this window when preferences cannot be saved.
    }
  }, []);
  return [visible, update] as const;
}
