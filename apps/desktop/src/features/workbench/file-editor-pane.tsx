import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { WorkspaceRecord, WorktreeRecord } from "../../../contracts/desktop-state";
import type { PiDesktopApi, WorkspaceFilePreview } from "../../../contracts/ipc";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CloseIcon, CopyIcon, WorktreeIcon } from "../../ui/icons";
import { HighlightedLine } from "../../ui/highlighted-line";
import { MAX_HIGHLIGHTED_LINES, extensionToLanguage } from "../../ui/syntax-highlight";
import {
  breadcrumbSegments,
  fileNameFromPath,
  isMarkdownPath,
  type FileLineMark,
  type FileWorkbenchTabs,
} from "./file-workbench-state";

interface FileEditorPaneProps {
  readonly api: PiDesktopApi;
  readonly workspace: WorkspaceRecord;
  readonly worktree: WorktreeRecord | undefined;
  readonly tabs: FileWorkbenchTabs;
  readonly onActivate: (path: string) => void;
  readonly onClose: (path: string) => void;
}

const FILE_MARKDOWN_COMPONENTS = {
  code: ({ className, children }: { className?: string; children?: ReactNode }) => {
    const code = String(children).replace(/\n$/, "");
    return <code className={className}>{code}</code>;
  },
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} rel="noreferrer" target="_blank">
      {children}
    </a>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <div className="message__table-scroll">
      <table>{children}</table>
    </div>
  ),
  img: ({ alt }: { alt?: string }) => (
    <span className="file-editor__blocked-image">{alt ? `[image: ${alt}]` : "[image]"}</span>
  ),
};

const FILE_MARKDOWN_PLUGINS = [remarkGfm];

export function FileEditorPane({
  api,
  workspace,
  worktree,
  tabs,
  onActivate,
  onClose,
}: FileEditorPaneProps) {
  const activePath = tabs.active;
  const lineMark = tabs.line;
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [sourceMode, setSourceMode] = useState(() => tabs.line !== null);
  const [sourceKey, setSourceKey] = useState(() => `${tabs.active ?? ""}:${tabs.lineNonce}`);
  const nextSourceKey = `${activePath ?? ""}:${tabs.lineNonce}`;
  if (sourceKey !== nextSourceKey) {
    setSourceKey(nextSourceKey);
    setSourceMode(lineMark !== null);
  }
  const markdown = activePath ? isMarkdownPath(activePath) : false;
  const worktreeLabel =
    workspace.kind === "worktree"
      ? (worktree?.name ?? workspace.branchName ?? workspace.name)
      : null;

  useEffect(() => {
    let cancelled = false;
    if (!activePath) {
      setPreview(null);
      setViewerError(null);
      setViewerLoading(false);
      return;
    }
    setViewerLoading(true);
    setViewerError(null);
    void api
      .readWorkspaceFile(workspace.id, activePath)
      .then((result) => {
        if (!cancelled) {
          setPreview(result);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPreview(null);
          setViewerError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setViewerLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activePath, api, workspace.id]);

  const showSource = !markdown || sourceMode;

  return (
    <section className="file-editor" data-testid="file-editor" aria-label="Open file">
      <div className="file-editor__tab-strip">
        {worktreeLabel ? (
          <span className="file-editor__worktree-chip" data-testid="file-editor-worktree-chip">
            <WorktreeIcon />
            <span>{worktreeLabel}</span>
          </span>
        ) : null}
        <div className="file-editor__tabs">
          {tabs.tabs.map((path) => {
            const selected = path === activePath;
            return (
              <div
                className={`file-editor__tab ${selected ? "file-editor__tab--active" : ""}`}
                data-testid="file-workbench-tab"
                key={path}
              >
                <button
                  aria-current={selected ? "page" : undefined}
                  className="file-editor__tab-button"
                  type="button"
                  onClick={() => onActivate(path)}
                >
                  {fileNameFromPath(path)}
                </button>
                <button
                  aria-label={`Close ${fileNameFromPath(path)}`}
                  className="file-editor__tab-close"
                  type="button"
                  onClick={() => onClose(path)}
                >
                  <CloseIcon />
                </button>
              </div>
            );
          })}
        </div>
        {activePath ? (
          <div className="file-editor__actions">
            {markdown ? (
              <button
                aria-pressed={showSource}
                className={
                  showSource
                    ? "file-workbench__mode file-workbench__mode--active"
                    : "file-workbench__mode"
                }
                type="button"
                onClick={() => setSourceMode((current) => !current)}
              >
                View source
              </button>
            ) : null}
            <button
              aria-label="Copy file"
              className="icon-button"
              disabled={!preview || preview.binary || Boolean(viewerError)}
              type="button"
              onClick={() => {
                if (preview && !preview.binary) {
                  void navigator.clipboard.writeText(preview.content).catch((error: unknown) => {
                    console.error("[renderer] copy file failed", error);
                  });
                }
              }}
            >
              <CopyIcon />
            </button>
            <button
              className="file-workbench__mode"
              disabled={!activePath}
              type="button"
              onClick={() => {
                void api.revealWorkspaceFile(workspace.id, activePath).catch((error: unknown) => {
                  setViewerError(error instanceof Error ? error.message : String(error));
                });
              }}
            >
              Open
            </button>
          </div>
        ) : null}
      </div>
      {activePath ? (
        <nav
          aria-label="File path"
          className="file-editor__breadcrumb"
          data-testid="file-editor-breadcrumb"
        >
          {breadcrumbSegments(activePath).map((segment, index, segments) => (
            <span key={`${segment}-${index}`}>
              {index > 0 ? <span className="file-editor__breadcrumb-sep">›</span> : null}
              <span className={index === segments.length - 1 ? "file-editor__breadcrumb-file" : ""}>
                {segment}
              </span>
            </span>
          ))}
        </nav>
      ) : null}
      <div className="file-editor__body">
        {renderEditorBody({
          activePath,
          lineMark: showSource ? lineMark : null,
          markdown,
          preview,
          showSource,
          viewerError,
          viewerLoading,
        })}
      </div>
    </section>
  );
}

function renderEditorBody({
  activePath,
  lineMark,
  markdown,
  preview,
  showSource,
  viewerError,
  viewerLoading,
}: {
  readonly activePath: string | null;
  readonly lineMark: FileLineMark | null;
  readonly markdown: boolean;
  readonly preview: WorkspaceFilePreview | null;
  readonly showSource: boolean;
  readonly viewerError: string | null;
  readonly viewerLoading: boolean;
}): ReactNode {
  if (!activePath) {
    return <div className="diff-panel__empty">Select a file from the explorer.</div>;
  }
  if (viewerLoading) {
    return <div className="diff-panel__empty">Loading file...</div>;
  }
  if (viewerError) {
    return <div className="diff-panel__empty">{viewerError}</div>;
  }
  if (!preview) {
    return <div className="diff-panel__empty">No preview available.</div>;
  }
  if (preview.binary) {
    return <div className="diff-panel__empty">Binary or directory preview is not available.</div>;
  }
  return (
    <>
      {markdown && !showSource ? (
        <FileMarkdown text={preview.content} />
      ) : (
        <SourceView content={preview.content} lineMark={lineMark} path={activePath} />
      )}
      {preview.truncated ? (
        <div className="file-editor__truncated" role="status">
          Preview truncated
        </div>
      ) : null}
    </>
  );
}

function FileMarkdown({ text }: { readonly text: string }) {
  return (
    <div className="file-editor__markdown message__content" data-testid="file-workbench-preview">
      <ReactMarkdown remarkPlugins={FILE_MARKDOWN_PLUGINS} components={FILE_MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function SourceView({
  path,
  content,
  lineMark,
}: {
  readonly path: string;
  readonly content: string;
  readonly lineMark: FileLineMark | null;
}) {
  const language = extensionToLanguage(path);
  const lines = content.split("\n");
  const highlightActive = language !== undefined && lines.length <= MAX_HIGHLIGHTED_LINES;
  const firstMarkedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const line = firstMarkedRef.current;
    if (line) {
      scrollIntoContainer(line, ".file-editor__body");
    }
  }, [content, lineMark, path]);
  return (
    <pre
      className="file-editor__source file-workbench__preview"
      data-testid="file-workbench-preview"
    >
      {lines.map((line, index) => {
        const lineNumber = index + 1;
        const marked =
          lineMark !== null && lineNumber >= lineMark.start && lineNumber <= lineMark.end;
        return (
          <div
            className={marked ? "file-editor__line file-editor__line--marked" : "file-editor__line"}
            data-line={lineNumber}
            data-testid={marked ? "file-line-mark" : undefined}
            key={lineNumber}
            ref={marked && lineNumber === lineMark?.start ? firstMarkedRef : undefined}
          >
            {highlightActive ? <HighlightedLine content={line} language={language} /> : line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function scrollIntoContainer(element: HTMLElement, containerSelector: string): void {
  const container = element.closest(containerSelector);
  if (!(container instanceof HTMLElement)) {
    return;
  }
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  if (elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom) {
    return;
  }
  const top =
    container.scrollTop +
    (elementRect.top - containerRect.top) -
    container.clientHeight / 2 +
    elementRect.height / 2;
  container.scrollTop = Math.max(0, top);
}
