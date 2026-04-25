import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PiDesktopApi } from "./ipc";
import { InlineDiff } from "./diff-inline";
import { RefreshIcon } from "./icons";
import { extensionToLanguage } from "./syntax-highlight";
import { loadReviewed, pruneReviewed, saveReviewed } from "./reviewed-files-store";

interface ChangedFile {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "untracked";
}

export interface DiffPanelFileRequest {
  readonly path: string;
  readonly nonce: number;
}

interface DiffPanelProps {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly api: PiDesktopApi;
  readonly sessionStatus: string | undefined;
  readonly fileRequest?: DiffPanelFileRequest | null;
}

export function DiffPanel({
  workspaceId,
  sessionId,
  api,
  sessionStatus,
  fileRequest,
}: DiffPanelProps) {
  const [files, setFiles] = useState<readonly ChangedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffText, setDiffText] = useState("");
  const [loading, setLoading] = useState(false);
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    setReviewed(loadReviewed(workspaceId, sessionId));
  }, [workspaceId, sessionId]);

  const refresh = useCallback(() => {
    setLoading(true);
    void api.getChangedFiles(workspaceId).then((result) => {
      setFiles(result);
      setSelectedFile((current) =>
        current && !result.some((f) => f.path === current) ? null : current,
      );
      setReviewed((current) => {
        const pruned = pruneReviewed(current, result.map((f) => f.path));
        if (pruned !== current) {
          saveReviewed(workspaceId, sessionId, pruned);
        }
        return pruned;
      });
      setLoading(false);
    });
  }, [api, workspaceId, sessionId]);

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
  }, [workspaceId]);

  useEffect(() => {
    if (!fileRequest) return;
    setSelectedFile(fileRequest.path);
  }, [fileRequest]);

  useEffect(() => {
    if (!selectedFile) {
      setDiffText("");
      return;
    }
    void api.getFileDiff(workspaceId, selectedFile).then(setDiffText);
  }, [api, workspaceId, selectedFile]);

  const fileListRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selectedFile) return;
    const row = fileListRef.current?.querySelector<HTMLElement>(
      `[data-file-path="${CSS.escape(selectedFile)}"]`,
    );
    row?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [selectedFile]);

  const handleStage = (filePath: string) => {
    void api.stageFile(workspaceId, filePath).then(refresh);
  };

  const toggleReviewed = useCallback(
    (filePath: string) => {
      setReviewed((current) => {
        const next = new Set(current);
        if (next.has(filePath)) {
          next.delete(filePath);
        } else {
          next.add(filePath);
        }
        saveReviewed(workspaceId, sessionId, next);
        return next;
      });
    },
    [workspaceId, sessionId],
  );

  const reviewedCount = useMemo(
    () => files.reduce((acc, f) => acc + (reviewed.has(f.path) ? 1 : 0), 0),
    [files, reviewed],
  );

  return (
    <aside className="diff-panel">
      <div className="diff-panel__header">
        <h2 className="diff-panel__title">Changes</h2>
        {files.length > 0 ? (
          <span className="diff-panel__counter" data-testid="diff-panel-counter">
            {`Reviewed ${reviewedCount} of ${files.length}`}
          </span>
        ) : null}
        <button
          className="icon-button"
          type="button"
          onClick={refresh}
          aria-label="Refresh"
          disabled={loading}
        >
          <RefreshIcon />
        </button>
      </div>

      {files.length === 0 ? (
        <div className="diff-panel__empty">No changes</div>
      ) : (
        <>
          <div className="diff-panel__file-list" ref={fileListRef}>
            {files.map((file) => {
              const isReviewed = reviewed.has(file.path);
              const isSelected = selectedFile === file.path;
              const className = [
                "diff-panel__file",
                isSelected ? "diff-panel__file--selected" : "",
                isReviewed ? "diff-panel__file--reviewed" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <div className={className} key={file.path} data-file-path={file.path}>
                  <input
                    aria-label={`Mark ${file.path} reviewed`}
                    className="diff-panel__reviewed-checkbox"
                    data-testid={`diff-panel-reviewed-${file.path}`}
                    type="checkbox"
                    checked={isReviewed}
                    onChange={() => toggleReviewed(file.path)}
                  />
                  <button
                    className="diff-panel__file-name"
                    type="button"
                    onClick={() => setSelectedFile(file.path === selectedFile ? null : file.path)}
                  >
                    <span className={`diff-panel__status-dot diff-panel__status-dot--${file.status}`} />
                    <span>{file.path}</span>
                  </button>
                  <button
                    className="diff-panel__stage-btn"
                    type="button"
                    onClick={() => handleStage(file.path)}
                  >
                    Stage
                  </button>
                </div>
              );
            })}
          </div>

          {selectedFile && diffText ? (
            <div className="diff-panel__viewer">
              <div className="diff-panel__viewer-header">{selectedFile}</div>
              <InlineDiff diff={diffText} language={extensionToLanguage(selectedFile)} />
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}
