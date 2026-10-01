import { useMemo, useRef } from "react";
import type {
  SessionTranscriptCustomMessage,
  SessionTranscriptMessage,
} from "@pi-gui/session-driver";
import type {
  DisplayTimelineItem,
  TimelineActivity,
  TimelineToolCall,
  TimelineSummary,
  TimelineTurnMarker,
} from "../../../contracts/timeline-types";
import type { ScheduledTaskOrigin } from "../../../contracts/scheduled-tasks";
import { extensionToolRowLabel } from "../../../contracts/tool-labels";
import { useExtensionToolLabel } from "../extensions/extension-tool-labels";
import {
  AnnotationMarkers,
  type AnnotationMarker,
  type OpenAnnotation,
} from "./annotations/annotation-markers";
import { parseAnnotatedPrompt } from "./annotations/annotation-prompt";
import { SentAnnotations } from "./annotations/sent-annotations";
import { ExtensionCardItem, type RunExtensionAction } from "./extension-card";
import { ImageAttachmentThumb } from "./image-attachment-thumb";
import { MessageMarkdown } from "./message-markdown";
import { TurnChangesCard, type OpenTurnChange } from "./turn-changes-card";
import type { WorkspaceFileLine } from "./workspace-file-line";
import { InlineDiff, extractDiffFromOutput } from "../../ui/diff-inline";
import {
  ChevronRightIcon,
  CopyIcon,
  DiffIcon,
  FileIcon,
  ForkIcon,
  SparkIcon,
  TerminalIcon,
} from "../../ui/icons";
import { extensionToLanguage } from "../../ui/syntax-highlight";

export function TimelineItem({
  item,
  expandedToolCallIds,
  onToggleToolCall,
  onViewFileInDiff,
  sourceMessageIndex,
  onForkFromMessage,
  onOpenTurnChange,
  scheduledOrigin,
  workspacePath,
  onOpenWorkspaceFileLine,
  onExtensionAction,
  annotationMarkers,
  onOpenAnnotation,
}: {
  readonly item: DisplayTimelineItem;
  readonly expandedToolCallIds?: ReadonlySet<string>;
  readonly onToggleToolCall?: (callId: string) => void;
  readonly onViewFileInDiff?: (path: string) => void;
  readonly sourceMessageIndex?: number;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
  readonly onOpenTurnChange?: OpenTurnChange;
  readonly scheduledOrigin?: ScheduledTaskOrigin;
  readonly workspacePath?: string;
  readonly onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void;
  readonly onExtensionAction?: RunExtensionAction;
  readonly annotationMarkers?: readonly AnnotationMarker[];
  readonly onOpenAnnotation?: OpenAnnotation;
}) {
  switch (item.kind) {
    case "turn-marker":
      return <TimelineTurnMarkerItem item={item} />;
    case "turn-changes":
      return <TurnChangesCard turn={item.turn} onOpen={onOpenTurnChange} />;
    case "message":
      return (
        <TimelineMessage
          item={item}
          sourceMessageIndex={sourceMessageIndex}
          onForkFromMessage={onForkFromMessage}
          onOpenWorkspaceFileLine={onOpenWorkspaceFileLine}
          scheduledOrigin={scheduledOrigin}
          workspacePath={workspacePath}
          annotationMarkers={annotationMarkers}
          onOpenAnnotation={onOpenAnnotation}
        />
      );
    case "activity":
      return <TimelineActivityItem item={item} />;
    case "tool":
      return (
        <TimelineToolCallItem
          item={item}
          expanded={expandedToolCallIds?.has(item.callId) ?? false}
          onToggle={onToggleToolCall}
          onViewFileInDiff={onViewFileInDiff}
        />
      );
    case "summary":
      return <TimelineSummaryItem item={item} />;
    case "custom":
      return <TimelineCustomMessage item={item} />;
    case "card":
      return <ExtensionCardItem card={item.card} onAction={onExtensionAction} />;
    default:
      return unhandledTimelineItem(item);
  }
}

function unhandledTimelineItem(item: never): null {
  console.warn("[timeline] unhandled item kind", item);
  return null;
}

/** An extension message, drawn like terminal pi: its customType labels the markdown. */
function TimelineCustomMessage({ item }: { readonly item: SessionTranscriptCustomMessage }) {
  return (
    <article className="timeline-item timeline-item--custom" data-testid="timeline-custom-message">
      <div className="timeline-item__custom-type">{item.customType}</div>
      <MessageMarkdown text={item.text} />
    </article>
  );
}

function TimelineMessage({
  item,
  sourceMessageIndex,
  onForkFromMessage,
  scheduledOrigin,
  workspacePath,
  onOpenWorkspaceFileLine,
  annotationMarkers,
  onOpenAnnotation,
}: {
  readonly item: SessionTranscriptMessage;
  readonly sourceMessageIndex?: number;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
  readonly scheduledOrigin?: ScheduledTaskOrigin;
  readonly workspacePath?: string;
  readonly onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void;
  readonly annotationMarkers?: readonly AnnotationMarker[];
  readonly onOpenAnnotation?: OpenAnnotation;
}) {
  const articleRef = useRef<HTMLElement | null>(null);
  const annotated = useMemo(
    () => (item.role === "user" ? parseAnnotatedPrompt(item.text) : null),
    [item.role, item.text],
  );
  const markers =
    annotationMarkers?.length && onOpenAnnotation ? (
      <AnnotationMarkers
        articleRef={articleRef}
        markers={annotationMarkers}
        messageId={item.id}
        onOpen={onOpenAnnotation}
      />
    ) : null;

  if (item.role === "user") {
    const body = annotated ? annotated.body : item.text;
    return (
      <article className="timeline-item timeline-item--user" ref={articleRef}>
        <div className="timeline-item__user-stack">
          {scheduledOrigin ? (
            <div className="timeline-item__scheduled-origin" data-testid="sent-by-scheduled-task">
              Sent by scheduled task
            </div>
          ) : null}
          <div className="timeline-item__bubble">
            {item.attachments?.length ? (
              <div className="timeline-item__attachments">
                {item.attachments.map((attachment, index) =>
                  attachment.kind === "image" ? (
                    <ImageAttachmentThumb
                      className="timeline-item__attachment timeline-item__attachment--image"
                      key={`${item.id}:${index}`}
                      name={attachment.name ?? `Attachment ${index + 1}`}
                      src={`data:${attachment.mimeType};base64,${attachment.data}`}
                    />
                  ) : (
                    <div
                      className="timeline-item__attachment timeline-item__attachment--file"
                      key={`${item.id}:${index}`}
                      title={attachment.fsPath}
                    >
                      <span className="timeline-item__attachment-icon" aria-hidden="true">
                        <FileIcon />
                      </span>
                      <span className="timeline-item__attachment-name">{attachment.name}</span>
                    </div>
                  ),
                )}
              </div>
            ) : null}
            {annotated ? <SentAnnotations annotations={annotated.annotations} /> : null}
            {annotated && !body.trim() ? null : <MessageMarkdown annotationRoot text={body} />}
          </div>
        </div>
        {markers}
      </article>
    );
  }

  if (item.role === "branchSummary" || item.role === "compactionSummary") {
    return (
      <article className="timeline-item timeline-item--summary-card">
        <div className="timeline-item__summary-eyebrow">
          {item.role === "branchSummary" ? "Branch summary" : "Compaction summary"}
        </div>
        <MessageMarkdown text={item.text} />
      </article>
    );
  }

  // The row stays while a run streams (Fork is disabled then), so the transcript never
  // shifts by the row's height when a run starts or ends.
  const forkable = sourceMessageIndex !== undefined;
  return (
    <article className="timeline-item timeline-item--assistant" ref={articleRef}>
      <MessageMarkdown
        annotationRoot
        onOpenWorkspaceFileLine={onOpenWorkspaceFileLine}
        text={item.text}
        workspacePath={workspacePath}
      />
      {forkable ? (
        <div className="timeline-item__actions">
          <button
            type="button"
            className="timeline-item__action"
            title={
              onForkFromMessage
                ? "Fork conversation from this point"
                : "Fork is available when the run finishes"
            }
            aria-label="Fork conversation from this point"
            data-testid="fork-from-message"
            disabled={!onForkFromMessage}
            onClick={() => onForkFromMessage?.(sourceMessageIndex, item.text)}
          >
            <ForkIcon />
            <span className="timeline-item__action-label">Fork</span>
          </button>
        </div>
      ) : null}
      {markers}
    </article>
  );
}

function TimelineActivityItem({ item }: { readonly item: TimelineActivity }) {
  return (
    <div className={`timeline-activity timeline-activity--${item.tone ?? "neutral"}`}>
      <span className="timeline-activity__label">{item.label}</span>
      {item.detail ? <span className="timeline-activity__detail">{item.detail}</span> : null}
      {item.metadata ? <span className="timeline-activity__meta">{item.metadata}</span> : null}
    </div>
  );
}

function TimelineToolCallItem({
  item,
  expanded,
  onToggle,
  onViewFileInDiff,
}: {
  readonly item: TimelineToolCall;
  readonly expanded: boolean;
  readonly onToggle?: (callId: string) => void;
  readonly onViewFileInDiff?: (path: string) => void;
}) {
  const hasContent = item.input !== undefined || item.output !== undefined;
  // An extension's tool shows the label it registered; its name says nothing about edits or files.
  const extensionLabel = useExtensionToolLabel(item.toolName);
  const writeTool = extensionLabel === undefined && isWriteTool(item.toolName);
  const diffText = writeTool ? extractDiffFromOutput(item.output) : undefined;
  const diffStats = diffText ? countDiffStats(diffText) : undefined;
  const compactLabel =
    extensionLabel === undefined
      ? buildCompactLabel(item, diffStats)
      : extensionToolRowLabel(extensionLabel, item.input);
  const filePath = writeTool ? extractFilename(item.input) || undefined : undefined;
  const diffLanguage = diffText && filePath ? extensionToLanguage(filePath) : undefined;
  const inlineDetail = item.status === "error" ? item.detail : undefined;

  const handleCopy = () => {
    const text = diffText ?? formatToolContent(item.input, item.output);
    void navigator.clipboard.writeText(text).catch((error: unknown) => {
      console.error("[renderer] navigator.clipboard.writeText failed", error);
    });
  };

  return (
    <article className={`timeline-tool timeline-tool--${item.status}`}>
      <div className="timeline-tool__header-row">
        <span className="timeline-tool__glyph" aria-hidden="true">
          {extensionLabel === undefined ? toolGlyph(item.toolName) : <SparkIcon />}
        </span>
        <button
          className="timeline-tool__header"
          type="button"
          aria-expanded={expanded}
          disabled={!hasContent}
          onClick={() => onToggle?.(item.callId)}
        >
          {hasContent ? (
            <span
              className={`timeline-tool__chevron ${expanded ? "timeline-tool__chevron--expanded" : ""}`}
            >
              <ChevronRightIcon />
            </span>
          ) : null}
          <span className="timeline-tool__label">{compactLabel}</span>
          {inlineDetail ? <span className="timeline-tool__detail">{inlineDetail}</span> : null}
          {diffStats ? (
            <span className="timeline-tool__diff-stats">
              <span className="timeline-tool__stat-add">+{diffStats.added}</span>{" "}
              <span className="timeline-tool__stat-del">-{diffStats.removed}</span>
            </span>
          ) : null}
          <span className="timeline-tool__meta-inline">
            <span className="timeline-tool__status-pip" aria-hidden="true" />
            {`${item.toolName} \u00b7 ${statusLabel(item.status)}`}
          </span>
        </button>
        {filePath && onViewFileInDiff ? (
          <button
            aria-label={`View ${filePath} in changes`}
            className="icon-button timeline-tool__view-in-diff"
            data-testid="timeline-tool-view-in-diff"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onViewFileInDiff(filePath);
            }}
          >
            <DiffIcon />
          </button>
        ) : null}
      </div>
      {expanded && hasContent ? (
        <div className="timeline-tool__body">
          {diffText ? (
            <>
              <div className="timeline-tool__diff-header">
                <span className="timeline-tool__diff-filename">
                  {extractFilename(item.input)}
                  {diffStats ? (
                    <span className="timeline-tool__diff-stats">
                      {" "}
                      <span className="timeline-tool__stat-add">+{diffStats.added}</span>{" "}
                      <span className="timeline-tool__stat-del">-{diffStats.removed}</span>
                    </span>
                  ) : null}
                </span>
                <button
                  className="icon-button timeline-tool__copy"
                  type="button"
                  onClick={handleCopy}
                  aria-label="Copy"
                >
                  <CopyIcon />
                </button>
              </div>
              <InlineDiff diff={diffText} language={diffLanguage} />
            </>
          ) : (
            <>
              <div className="timeline-tool__body-actions">
                <button
                  className="icon-button timeline-tool__copy"
                  type="button"
                  onClick={handleCopy}
                  aria-label="Copy"
                >
                  <CopyIcon />
                </button>
              </div>
              <pre className="timeline-tool__pre">{formatToolContent(item.input, item.output)}</pre>
            </>
          )}
        </div>
      ) : null}
    </article>
  );
}

function isWriteTool(toolName: string): boolean {
  return /write|edit|patch|apply/i.test(toolName);
}

function toolGlyph(toolName: string) {
  if (isWriteTool(toolName)) {
    return <DiffIcon />;
  }
  if (/bash|shell|exec|terminal|command|run/i.test(toolName)) {
    return <TerminalIcon />;
  }
  if (/read|view|cat|open|file|glob|grep|search|ls/i.test(toolName)) {
    return <FileIcon />;
  }
  return <SparkIcon />;
}

function buildCompactLabel(
  item: TimelineToolCall,
  diffStats: { added: number; removed: number } | undefined,
): string {
  if (isWriteTool(item.toolName)) {
    const filename = extractFilename(item.input);
    if (filename) {
      return `Edited ${shortenPath(filename)}`;
    }
  }
  return item.label;
}

function extractFilename(input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    const path = record.file_path ?? record.filePath ?? record.path ?? record.filename;
    if (typeof path === "string") {
      return path;
    }
  }
  return "";
}

function shortenPath(filePath: string): string {
  // Show last 2-3 path segments for readability
  const parts = filePath.split("/");
  if (parts.length <= 3) {
    return filePath;
  }
  return parts.slice(-3).join("/");
}

function countDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function formatToolContent(input: unknown, output: unknown): string {
  const parts: string[] = [];
  if (input !== undefined) {
    parts.push(typeof input === "string" ? input : JSON.stringify(input, null, 2));
  }
  if (output !== undefined) {
    parts.push(typeof output === "string" ? output : JSON.stringify(output, null, 2));
  }
  return parts.join("\n\n");
}

function statusLabel(status: "running" | "success" | "error") {
  if (status === "running") return "running";
  if (status === "success") return "done";
  return "failed";
}

function TimelineTurnMarkerItem({ item }: { readonly item: TimelineTurnMarker }) {
  return (
    <div className="timeline-turn-marker" data-testid="timeline-turn-marker">
      <span className="timeline-turn-marker__label">{`Worked for ${formatWorkedDuration(item.durationMs)}`}</span>
    </div>
  );
}

function formatWorkedDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function TimelineSummaryItem({ item }: { readonly item: TimelineSummary }) {
  if (item.presentation === "divider") {
    return (
      <div className="timeline-summary">
        <span>{item.label}</span>
        {item.metadata ? <span className="timeline-summary__meta">{item.metadata}</span> : null}
      </div>
    );
  }

  return (
    <div className="timeline-activity timeline-activity--summary">
      <span className="timeline-activity__label">{item.label}</span>
      {item.metadata ? <span className="timeline-activity__meta">{item.metadata}</span> : null}
    </div>
  );
}
