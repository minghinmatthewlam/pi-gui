import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffPanelFileRequest, FileWorkbenchContext } from "./diff-panel-types";
import type {
  ChangedFileEntry,
  ChangedFilesResult,
  PiDesktopApi,
  WorkspaceFilePreview,
} from "../../../contracts/ipc";
import { InlineDiff } from "../../ui/diff-inline";
import { RefreshIcon } from "../../ui/icons";
import { extensionToLanguage } from "../../ui/syntax-highlight";
import { loadReviewed, pruneReviewed, saveReviewed } from "./reviewed-files-store";

interface WorkbenchChangedFile extends ChangedFileEntry {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly branchName?: string;
}

interface FileSelection {
  readonly workspaceId: string;
  readonly path: string;
}

interface DiffPanelProps {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly api: PiDesktopApi;
  readonly sessionStatus: string | undefined;
  readonly fileRequest?: DiffPanelFileRequest | null;
  readonly contexts: readonly FileWorkbenchContext[];
}

export function DiffPanel({
  workspaceId,
  sessionId,
  api,
  sessionStatus,
  fileRequest,
  contexts,
}: DiffPanelProps) {
  const [filesByWorkspace, setFilesByWorkspace] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const [changedByWorkspace, setChangedByWorkspace] = useState<
    Readonly<Record<string, ChangedFilesResult>>
  >({});
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(workspaceId);
  const [selectedFile, setSelectedFile] = useState<FileSelection | null>(null);
  const [viewerMode, setViewerMode] = useState<"preview" | "diff">("preview");
  const [diffText, setDiffText] = useState("");
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(() =>
    loadReviewed(workspaceId, sessionId),
  );
  const contextsRef = useRef(contexts);
  const viewerRequestNonceRef = useRef(0);
  const refreshRequestNonceRef = useRef(0);

  const contextIdsKey = useMemo(
    () => contexts.map((context) => context.workspace.id).join("\n"),
    [contexts],
  );
  const knownContextIds = useMemo(
    () => new Set(contextIdsKey ? contextIdsKey.split("\n") : []),
    [contextIdsKey],
  );
  const activeContext =
    contexts.find((context) => context.workspace.id === activeWorkspaceId) ?? contexts[0];
  const changedGroups = useMemo(
    () =>
      contexts.map((context) => {
        const result = changedByWorkspace[context.workspace.id];
        return {
          context,
          error: result?.state === "unavailable" ? result.error : undefined,
          pending: result === undefined,
          files:
            result?.state === "available"
              ? result.files.map((file) => toWorkbenchChangedFile(context, file))
              : [],
        };
      }),
    [changedByWorkspace, contexts],
  );
  const changedRows = useMemo(() => changedGroups.flatMap((group) => group.files), [changedGroups]);
  const unavailableChangedGroupCount = useMemo(
    () => changedGroups.reduce((count, group) => count + (group.error ? 1 : 0), 0),
    [changedGroups],
  );
  const pendingChangedGroupCount = useMemo(
    () => changedGroups.reduce((count, group) => count + (group.pending ? 1 : 0), 0),
    [changedGroups],
  );
  const changedFilesSummary = buildChangedFilesSummary(
    changedRows.length,
    unavailableChangedGroupCount,
    pendingChangedGroupCount,
  );
  const changedRowsRef = useRef(changedRows);
  changedRowsRef.current = changedRows;
  const filesByWorkspaceRef = useRef(filesByWorkspace);
  filesByWorkspaceRef.current = filesByWorkspace;

  useEffect(() => {
    setReviewed(loadReviewed(workspaceId, sessionId));
  }, [workspaceId, sessionId]);

  useEffect(() => {
    contextsRef.current = contexts;
  }, [contexts]);

  useEffect(() => {
    if (knownContextIds.has(activeWorkspaceId)) {
      return;
    }
    setActiveWorkspaceId(workspaceId);
  }, [activeWorkspaceId, knownContextIds, workspaceId]);

  const refresh = useCallback(
    (options: { readonly force?: boolean } = {}) => {
      const refreshContexts = contextsRef.current;
      // Latest-request-wins: overlapping refreshes (e.g. running→idle firing alongside a
      // context/mount refresh) must not let a slower earlier request overwrite newer state.
      refreshRequestNonceRef.current += 1;
      const requestNonce = refreshRequestNonceRef.current;
      if (refreshContexts.length === 0) {
        setFilesByWorkspace({});
        setChangedByWorkspace({});
        return;
      }

      setLoading(true);
      void Promise.all(
        refreshContexts.map(async (context) => {
          const [workspaceFiles, changedFiles] = await Promise.all([
            api.listWorkspaceFiles(context.workspace.id, { force: options.force ?? false }),
            api.getChangedFiles(context.workspace.id),
          ]);
          return { workspaceId: context.workspace.id, workspaceFiles, changedFiles };
        }),
      )
        .then((results) => {
          if (refreshRequestNonceRef.current !== requestNonce) {
            return;
          }
          const nextFilesByWorkspace: Record<string, readonly string[]> = {};
          const nextChangedByWorkspace: Record<string, ChangedFilesResult> = {};
          for (const result of results) {
            nextFilesByWorkspace[result.workspaceId] = result.workspaceFiles;
            nextChangedByWorkspace[result.workspaceId] = result.changedFiles;
          }
          setFilesByWorkspace(nextFilesByWorkspace);
          setChangedByWorkspace(nextChangedByWorkspace);
          setSelectedFile((current) => {
            if (!current) {
              return null;
            }
            const changedResult = nextChangedByWorkspace[current.workspaceId];
            const changedFiles = changedResult?.state === "available" ? changedResult.files : [];
            const availableFiles = new Set([
              ...(nextFilesByWorkspace[current.workspaceId] ?? []),
              ...changedFiles.map((file) => file.path),
            ]);
            return availableFiles.has(current.path) ? current : null;
          });
          setReviewed((current) => {
            const unavailableWorkspaceIds = new Set(
              results
                .filter((result) => result.changedFiles.state === "unavailable")
                .map((result) => result.workspaceId),
            );
            const retainedUnavailableKeys = [...current].filter((key) => {
              const reviewedWorkspaceId = workspaceIdFromReviewedFileKey(key);
              return (
                reviewedWorkspaceId !== undefined &&
                unavailableWorkspaceIds.has(reviewedWorkspaceId)
              );
            });
            const pruned = pruneReviewed(current, [
              ...results.flatMap((result) =>
                result.changedFiles.state === "available"
                  ? result.changedFiles.files.map((file) =>
                      reviewedFileKey(result.workspaceId, file.path),
                    )
                  : [],
              ),
              ...retainedUnavailableKeys,
            ]);
            if (pruned !== current) {
              saveReviewed(workspaceId, sessionId, pruned);
            }
            return pruned;
          });
        })
        .finally(() => {
          if (refreshRequestNonceRef.current === requestNonce) {
            setLoading(false);
          }
        })
        .catch((error: unknown) => {
          console.error("[renderer] Promise.all failed", error);
        });
    },
    [api, contextIdsKey, sessionId, workspaceId],
  );

  const prevStatusRef = useRef(sessionStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = sessionStatus;
    if (prev === "running" && sessionStatus !== "running") {
      refresh();
    }
  }, [sessionStatus, refresh]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Resolve the workspace/worktree a requested path actually belongs to, mirroring the in-list
  // click path (which uses file.workspaceId). Falling back to the top-level workspaceId prop would
  // query the wrong tree in multi-context (worktree) views.
  const resolveWorkspaceIdForPath = useCallback(
    (path: string): string => {
      const changedMatch = changedRowsRef.current.find((file) => file.path === path);
      if (changedMatch) {
        return changedMatch.workspaceId;
      }
      for (const context of contextsRef.current) {
        if ((filesByWorkspaceRef.current[context.workspace.id] ?? []).includes(path)) {
          return context.workspace.id;
        }
      }
      return workspaceId;
    },
    [workspaceId],
  );

  useEffect(() => {
    if (!fileRequest) {
      return;
    }
    setViewerMode("diff");
    setSelectedFile({
      workspaceId: resolveWorkspaceIdForPath(fileRequest.path),
      path: fileRequest.path,
    });
  }, [fileRequest, resolveWorkspaceIdForPath]);

  useEffect(() => {
    viewerRequestNonceRef.current += 1;
    const requestNonce = viewerRequestNonceRef.current;
    if (!selectedFile) {
      setDiffText("");
      setPreview(null);
      setViewerError(null);
      setViewerLoading(false);
      return;
    }

    setViewerLoading(true);
    setViewerError(null);
    if (viewerMode === "diff") {
      setPreview(null);
      void api
        .getFileDiff(selectedFile.workspaceId, selectedFile.path)
        .then((result) => {
          if (viewerRequestNonceRef.current === requestNonce) {
            setDiffText(result);
          }
        })
        .catch((error) => {
          if (viewerRequestNonceRef.current === requestNonce) {
            setDiffText("");
            setViewerError(error instanceof Error ? error.message : String(error));
          }
        })
        .finally(() => {
          if (viewerRequestNonceRef.current === requestNonce) {
            setViewerLoading(false);
          }
        });
      return;
    }

    setDiffText("");
    void api
      .readWorkspaceFile(selectedFile.workspaceId, selectedFile.path)
      .then((result) => {
        if (viewerRequestNonceRef.current === requestNonce) {
          setPreview(result);
        }
      })
      .catch((error) => {
        if (viewerRequestNonceRef.current === requestNonce) {
          setPreview(null);
          setViewerError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (viewerRequestNonceRef.current === requestNonce) {
          setViewerLoading(false);
        }
      });
  }, [api, selectedFile, viewerMode]);

  const fileListRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selectedFile) {
      return;
    }
    const row = fileListRef.current?.querySelector<HTMLElement>(
      `[data-file-path="${CSS.escape(selectedFile.path)}"]`,
    );
    row?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [selectedFile, changedRows]);

  const handleStage = (file: WorkbenchChangedFile) => {
    void api
      .stageFile(file.workspaceId, file.path, file.stagingSourcePath)
      .then(() => refresh())
      .catch((error: unknown) => {
        setViewerError(error instanceof Error ? error.message : String(error));
      });
  };

  const toggleReviewed = useCallback(
    (file: WorkbenchChangedFile) => {
      setReviewed((current) => {
        const key = reviewedFileKey(file.workspaceId, file.path);
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        saveReviewed(workspaceId, sessionId, next);
        return next;
      });
    },
    [workspaceId, sessionId],
  );

  const reviewedCount = useMemo(
    () =>
      changedRows.reduce(
        (acc, file) => acc + (reviewed.has(reviewedFileKey(file.workspaceId, file.path)) ? 1 : 0),
        0,
      ),
    [changedRows, reviewed],
  );
  const showContextStrip = contexts.length > 1;
  const showReviewCounter = changedRows.length > 0;

  return (
    <section className="side-panel diff-panel file-workbench file-workbench--changes">
      <div className="diff-panel__header file-workbench__header">
        <div className="file-workbench__heading">
          <h2 className="diff-panel__title">Changes</h2>
          <span className="file-workbench__subtitle">{buildSubtitle(activeContext)}</span>
        </div>
        {showReviewCounter ? (
          <span className="diff-panel__counter" data-testid="diff-panel-counter">
            {`Reviewed ${reviewedCount} of ${changedRows.length}`}
          </span>
        ) : null}
        <button
          className="icon-button"
          type="button"
          onClick={() => refresh({ force: true })}
          aria-label="Refresh"
          disabled={loading}
        >
          <RefreshIcon />
        </button>
      </div>

      {showContextStrip ? (
        <div className="file-workbench__context-strip" aria-label="File scopes">
          {contexts.map((context) => {
            const isActive = activeContext?.workspace.id === context.workspace.id;
            const changedResult = changedByWorkspace[context.workspace.id];
            const changeCount =
              changedResult?.state === "available" ? changedResult.files.length : 0;
            return (
              <button
                className={`file-workbench__context ${isActive ? "file-workbench__context--active" : ""}`}
                key={context.workspace.id}
                type="button"
                onClick={() => setActiveWorkspaceId(context.workspace.id)}
              >
                <span>{contextLabel(context)}</span>
                <strong>
                  {changedResult === undefined
                    ? "Loading"
                    : changedResult.state === "unavailable"
                      ? "Unavailable"
                      : changeCount}
                </strong>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="file-workbench__body">
        <section
          className="file-workbench__section file-workbench__section--changes"
          aria-label="Changed files"
        >
          <div className="file-workbench__section-header">
            <span>Changed files</span>
            <span>{changedFilesSummary}</span>
          </div>
          {changedRows.length === 0 && unavailableChangedGroupCount === 0 ? (
            <div className="diff-panel__empty">
              {pendingChangedGroupCount > 0 ? "Loading changes..." : "No changes"}
            </div>
          ) : (
            <div className="diff-panel__file-list" ref={fileListRef}>
              {changedGroups.map((group) =>
                group.files.length === 0 && !group.error ? null : (
                  <div className="file-workbench__change-group" key={group.context.workspace.id}>
                    {showContextStrip ? (
                      <div className="file-workbench__change-heading">
                        <span>{contextLabel(group.context)}</span>
                        <span>{group.error ? "Unavailable" : group.files.length}</span>
                      </div>
                    ) : null}
                    {group.error ? (
                      <div
                        className="diff-panel__empty diff-panel__unavailable"
                        data-testid="changed-files-unavailable"
                        role="status"
                      >
                        {group.error.message}
                      </div>
                    ) : (
                      group.files.map((file) => {
                        const isReviewed = reviewed.has(
                          reviewedFileKey(file.workspaceId, file.path),
                        );
                        const isSelected =
                          viewerMode === "diff" &&
                          selectedFile?.workspaceId === file.workspaceId &&
                          selectedFile.path === file.path;
                        const className = [
                          "diff-panel__file",
                          isSelected ? "diff-panel__file--selected" : "",
                          isReviewed ? "diff-panel__file--reviewed" : "",
                        ]
                          .filter(Boolean)
                          .join(" ");
                        return (
                          <div
                            className={className}
                            key={`${file.workspaceId}:${file.path}`}
                            data-file-path={file.path}
                          >
                            <input
                              aria-label={`Mark ${file.path} reviewed`}
                              className="diff-panel__reviewed-checkbox"
                              data-testid={`diff-panel-reviewed-${file.path}`}
                              type="checkbox"
                              checked={isReviewed}
                              onChange={() => toggleReviewed(file)}
                            />
                            <button
                              className="diff-panel__file-name"
                              type="button"
                              onClick={() => {
                                setViewerMode("diff");
                                setSelectedFile(
                                  isSelected
                                    ? null
                                    : { workspaceId: file.workspaceId, path: file.path },
                                );
                              }}
                            >
                              <span
                                className={`diff-panel__status-dot diff-panel__status-dot--${file.status}`}
                              />
                              <span className="diff-panel__file-path">
                                {formatPathForDisplay(file.path)}
                              </span>
                              <span className="file-workbench__status-label">
                                {statusLabel(file)}
                              </span>
                            </button>
                            <button
                              className="diff-panel__stage-btn"
                              type="button"
                              onClick={() => handleStage(file)}
                              disabled={file.staged}
                            >
                              {file.staged ? "Staged" : "Stage"}
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                ),
              )}
            </div>
          )}
        </section>
      </div>

      <div className="diff-panel__viewer file-workbench__viewer">
        <div className="diff-panel__viewer-header file-workbench__viewer-header">
          <span className="file-workbench__viewer-path">
            {selectedFile ? formatPathForDisplay(selectedFile.path) : "Select a file"}
          </span>
          {selectedFile ? (
            <span className="file-workbench__viewer-modes" role="group" aria-label="Viewer mode">
              <button
                className={
                  viewerMode === "preview"
                    ? "file-workbench__mode file-workbench__mode--active"
                    : "file-workbench__mode"
                }
                type="button"
                onClick={() => setViewerMode("preview")}
              >
                File
              </button>
              <button
                className={
                  viewerMode === "diff"
                    ? "file-workbench__mode file-workbench__mode--active"
                    : "file-workbench__mode"
                }
                type="button"
                onClick={() => setViewerMode("diff")}
              >
                Diff
              </button>
            </span>
          ) : null}
        </div>
        {renderViewer({
          selectedFile,
          viewerMode,
          viewerLoading,
          viewerError,
          preview,
          diffText,
        })}
      </div>
    </section>
  );
}

function renderViewer({
  selectedFile,
  viewerMode,
  viewerLoading,
  viewerError,
  preview,
  diffText,
}: {
  readonly selectedFile: FileSelection | null;
  readonly viewerMode: "preview" | "diff";
  readonly viewerLoading: boolean;
  readonly viewerError: string | null;
  readonly preview: WorkspaceFilePreview | null;
  readonly diffText: string;
}) {
  if (!selectedFile) {
    return <div className="diff-panel__empty">Select a file from the changed files.</div>;
  }
  if (viewerLoading) {
    return <div className="diff-panel__empty">Loading {viewerMode}...</div>;
  }
  if (viewerError) {
    return <div className="diff-panel__empty">{viewerError}</div>;
  }
  if (viewerMode === "diff") {
    return diffText ? (
      <InlineDiff diff={diffText} language={extensionToLanguage(selectedFile.path)} />
    ) : (
      <div className="diff-panel__empty">No diff available for this file.</div>
    );
  }
  if (!preview) {
    return <div className="diff-panel__empty">No preview available.</div>;
  }
  if (preview.binary) {
    return <div className="diff-panel__empty">Binary or directory preview is not available.</div>;
  }
  return (
    <pre className="file-workbench__preview" data-testid="file-workbench-preview">
      {preview.content}
      {preview.truncated ? "\n\n[Preview truncated]" : ""}
    </pre>
  );
}

function toWorkbenchChangedFile(
  context: FileWorkbenchContext,
  file: ChangedFileEntry,
): WorkbenchChangedFile {
  return {
    ...file,
    workspaceId: context.workspace.id,
    workspaceName: context.workspace.name,
    branchName: context.worktree?.branchName ?? context.workspace.branchName,
  };
}

function reviewedFileKey(workspaceId: string, filePath: string): string {
  return JSON.stringify([workspaceId, filePath]);
}

function workspaceIdFromReviewedFileKey(key: string): string | undefined {
  try {
    const value: unknown = JSON.parse(key);
    return Array.isArray(value) && value.length === 2 && typeof value[0] === "string"
      ? value[0]
      : undefined;
  } catch {
    return undefined;
  }
}

function formatPathForDisplay(path: string): string {
  return JSON.stringify(path);
}

function contextLabel(context: FileWorkbenchContext): string {
  if (context.role === "thread") {
    return "Current thread";
  }
  if (context.role === "worktree") {
    return context.worktree?.branchName ?? context.workspace.branchName ?? context.workspace.name;
  }
  return context.workspace.name;
}

function buildSubtitle(context: FileWorkbenchContext | undefined): string {
  if (!context) {
    return "No workspace selected";
  }
  if (context.role === "worktree") {
    return `Worktree ${context.worktree?.branchName ?? context.workspace.name}`;
  }
  return context.workspace.path;
}

function statusLabel(file: WorkbenchChangedFile): string {
  const branch = file.branchName ? ` · ${file.branchName}` : "";
  return `${file.status}${branch}`;
}

function buildChangedFilesSummary(
  changedCount: number,
  unavailableCount: number,
  pendingCount: number,
): string {
  const parts = [
    changedCount > 0 ? String(changedCount) : "",
    unavailableCount > 0 ? `${unavailableCount} unavailable` : "",
    pendingCount > 0 ? `${pendingCount} loading` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "0";
}
