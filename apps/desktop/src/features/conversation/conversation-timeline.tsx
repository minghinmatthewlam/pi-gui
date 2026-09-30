import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { TranscriptMessage } from "../../../contracts/desktop-state";
import type { DisplayTimelineItem } from "../../../contracts/timeline-types";
import type { ScheduledTaskOrigin } from "../../../contracts/scheduled-tasks";
import type { TimelineViewport } from "./hooks/use-timeline-viewport";
import { ThreadSearchBar } from "./thread-search";
import { TimelineItem } from "./timeline-item";
import type { OpenTurnChange } from "./turn-changes-card";
import type { WorkspaceFileLine } from "./workspace-file-line";
import { SparkIcon } from "../../ui/icons";

interface ThreadSearchModel {
  readonly isOpen: boolean;
  readonly query: string;
  readonly matchCount: number;
  readonly activeIndex: number;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly search: (query: string) => void;
  readonly goToMatch: (direction: 1 | -1) => void;
  readonly close: () => void;
}
interface ConversationTimelineProps {
  readonly transcript: readonly TranscriptMessage[];
  readonly isTranscriptLoading: boolean;
  readonly transcriptFailed?: { readonly retrying: boolean } | null;
  readonly onRetryTranscript?: () => void;
  readonly viewport: TimelineViewport;
  readonly threadSearch: ThreadSearchModel;
  readonly onViewFileInDiff?: (path: string) => void;
  readonly onOpenTurnChange?: OpenTurnChange;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
  readonly onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void;
  readonly scheduledOrigins?: ReadonlyMap<string, ScheduledTaskOrigin>;
  readonly workspacePath?: string;
}
export function ConversationTimeline({
  transcript,
  isTranscriptLoading,
  transcriptFailed = null,
  onRetryTranscript,
  viewport,
  threadSearch,
  onViewFileInDiff,
  onOpenTurnChange,
  onForkFromMessage,
  onOpenWorkspaceFileLine,
  scheduledOrigins,
  workspacePath,
}: ConversationTimelineProps) {
  const [expandedToolCallIds, setExpandedToolCallIds] = useState<Set<string>>(() => new Set());
  const toggleToolCall = useCallback(
    (id: string) =>
      setExpandedToolCallIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  useLayoutEffect(() => {
    const available = new Set(
      transcript.filter((item) => item.kind === "tool").map((item) => item.callId),
    );
    setExpandedToolCallIds((current) => {
      if ([...current].every((id) => available.has(id))) return current;
      return new Set([...current].filter((id) => available.has(id)));
    });
  }, [transcript]);
  const renderedMessageIndexById = useMemo(() => {
    const indices = new Map<string, number>();
    let index = 0;
    for (const item of transcript) if (item.kind === "message") indices.set(item.id, index++);
    return indices;
  }, [transcript]);
  return (
    <div className="timeline-surface">
      <div className="timeline-column">
        {threadSearch.isOpen ? (
          <ThreadSearchBar
            query={threadSearch.query}
            matchCount={threadSearch.matchCount}
            activeIndex={threadSearch.activeIndex}
            inputRef={threadSearch.inputRef}
            onSearch={threadSearch.search}
            onNext={() => threadSearch.goToMatch(1)}
            onPrev={() => threadSearch.goToMatch(-1)}
            onClose={threadSearch.close}
          />
        ) : null}
        <div
          className="timeline-pane timeline-pane--thread"
          data-testid="timeline-pane"
          ref={viewport.attachPane}
          tabIndex={0}
        >
          {transcriptFailed ? (
            <div className="timeline" data-testid="transcript">
              <TranscriptHydrateError
                retrying={transcriptFailed.retrying}
                onRetry={onRetryTranscript}
              />
            </div>
          ) : isTranscriptLoading ? (
            <div className="timeline" data-testid="transcript">
              <TranscriptSkeleton />
            </div>
          ) : transcript.length === 0 ? (
            <div className="timeline" data-testid="transcript">
              <TranscriptEmptyState />
            </div>
          ) : (
            <div
              className="timeline timeline--virtualized"
              data-testid="transcript"
              style={{ height: viewport.totalHeight }}
            >
              {viewport.visibleRows.map(({ item, top }) => (
                <MeasuredTimelineItem
                  key={item.id}
                  item={item}
                  top={top}
                  className="timeline__virtual-row"
                  onHeightChange={viewport.measureRow}
                  generation={viewport.layoutGeneration}
                  expandedToolCallIds={expandedToolCallIds}
                  onToggleToolCall={toggleToolCall}
                  onViewFileInDiff={onViewFileInDiff}
                  onOpenTurnChange={onOpenTurnChange}
                  sourceMessageIndex={renderedMessageIndexById.get(item.id)}
                  onForkFromMessage={onForkFromMessage}
                  onOpenWorkspaceFileLine={onOpenWorkspaceFileLine}
                  workspacePath={workspacePath}
                  scheduledOrigin={
                    item.kind === "message" ? scheduledOrigins?.get(item.id) : undefined
                  }
                />
              ))}
            </div>
          )}
          {!transcriptFailed && viewport.showJumpToLatest ? (
            <button
              className="timeline-jump"
              data-testid="timeline-jump"
              type="button"
              onClick={viewport.jumpToLatest}
            >
              New activity below
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TranscriptSkeleton() {
  return (
    <div className="transcript-skeleton" data-testid="transcript-skeleton" aria-hidden="true">
      <div className="transcript-skeleton__row transcript-skeleton__row--user">
        <span className="skeleton-line" style={{ width: "42%" }} />
      </div>
      <div className="transcript-skeleton__row">
        <span className="skeleton-line" style={{ width: "88%" }} />
        <span className="skeleton-line" style={{ width: "94%" }} />
        <span className="skeleton-line" style={{ width: "66%" }} />
      </div>
      <div className="transcript-skeleton__row transcript-skeleton__row--tool">
        <span className="skeleton-line skeleton-line--tool" style={{ width: "38%" }} />
      </div>
      <div className="transcript-skeleton__row">
        <span className="skeleton-line" style={{ width: "80%" }} />
        <span className="skeleton-line" style={{ width: "72%" }} />
      </div>
      <span className="sr-only">Loading transcript…</span>
    </div>
  );
}

function TranscriptHydrateError({
  retrying,
  onRetry,
}: {
  readonly retrying: boolean;
  readonly onRetry?: () => void;
}) {
  return (
    <div className="transcript-hydrate-error" data-testid="transcript-hydrate-error">
      <h2>Couldn't load this thread</h2>
      <p>The selected conversation couldn't be restored. Retry to try again.</p>
      <div className="transcript-hydrate-error__actions">
        <button
          className="button button--primary"
          data-testid="hydrate-retry"
          type="button"
          disabled={retrying || !onRetry}
          onClick={onRetry}
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
      </div>
    </div>
  );
}

function TranscriptEmptyState() {
  return (
    <div className="transcript-empty" data-testid="transcript-empty">
      <span className="transcript-empty__glyph" aria-hidden="true">
        <SparkIcon />
      </span>
      <p className="transcript-empty__title">Start the conversation</p>
      <p className="transcript-empty__hint">Send a prompt below to begin this session.</p>
    </div>
  );
}

interface MeasuredTimelineItemProps {
  readonly item: DisplayTimelineItem;
  readonly className?: string;
  readonly top?: number;
  readonly onHeightChange: (id: string, height: number, generation: number) => void;
  readonly generation: number;
  readonly expandedToolCallIds: ReadonlySet<string>;
  readonly onToggleToolCall: (callId: string) => void;
  readonly onViewFileInDiff?: (path: string) => void;
  readonly onOpenTurnChange?: OpenTurnChange;
  readonly sourceMessageIndex?: number;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
  readonly onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void;
  readonly scheduledOrigin?: ScheduledTaskOrigin;
  readonly workspacePath?: string;
}

function MeasuredTimelineItemBase({
  item,
  className,
  top,
  onHeightChange,
  generation,
  expandedToolCallIds,
  onToggleToolCall,
  onViewFileInDiff,
  onOpenTurnChange,
  sourceMessageIndex,
  onForkFromMessage,
  onOpenWorkspaceFileLine,
  scheduledOrigin,
  workspacePath,
}: MeasuredTimelineItemProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const element = rowRef.current;
    if (!element) {
      return undefined;
    }

    const measure = () => {
      onHeightChange(item.id, element.getBoundingClientRect().height, generation);
    };

    measure();
    const resizeObserver = new ResizeObserver(() => {
      measure();
    });
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, [item, onHeightChange, generation]);

  return (
    <div
      className={className}
      ref={rowRef}
      data-message-id={item.id}
      style={top == null ? undefined : { transform: `translateY(${top}px)` }}
    >
      <TimelineItem
        item={item}
        expandedToolCallIds={expandedToolCallIds}
        onToggleToolCall={onToggleToolCall}
        onViewFileInDiff={onViewFileInDiff}
        onOpenTurnChange={onOpenTurnChange}
        sourceMessageIndex={sourceMessageIndex}
        onForkFromMessage={onForkFromMessage}
        onOpenWorkspaceFileLine={onOpenWorkspaceFileLine}
        scheduledOrigin={scheduledOrigin}
        workspacePath={workspacePath}
      />
    </div>
  );
}

// The transcript array is rebuilt with fresh item objects on every session
// update, so reference equality on `item` would re-render all rows each
// streaming tick — on long threads (virtualization off) that means re-running
// every row several times per second, which saturates the renderer. Compare
// items structurally by the fields that actually affect their rendering.
function isSameDisplayItem(a: DisplayTimelineItem, b: DisplayTimelineItem): boolean {
  if (a === b) {
    return true;
  }
  if (a.kind !== b.kind || a.id !== b.id) {
    return false;
  }
  if (a.kind === "message" && b.kind === "message") {
    return (
      a.role === b.role &&
      a.text === b.text &&
      a.attachments === b.attachments &&
      a.sourceMessageId === b.sourceMessageId
    );
  }
  if (a.kind === "tool" && b.kind === "tool") {
    // input/output are rebuilt objects on every transcript update, so identity
    // comparison would re-render every tool row per streaming tick. All visible
    // transitions (result arrival, failure) flip status and/or the derived
    // label/detail/metadata strings, so compare those instead.
    return (
      a.status === b.status &&
      a.toolName === b.toolName &&
      a.label === b.label &&
      a.detail === b.detail &&
      a.metadata === b.metadata
    );
  }
  if (a.kind === "activity" && b.kind === "activity") {
    return (
      a.label === b.label && a.detail === b.detail && a.metadata === b.metadata && a.tone === b.tone
    );
  }
  if (a.kind === "summary" && b.kind === "summary") {
    return a.label === b.label && a.metadata === b.metadata && a.presentation === b.presentation;
  }
  if (a.kind === "turn-marker" && b.kind === "turn-marker") {
    return a.durationMs === b.durationMs;
  }
  if (a.kind === "turn-changes" && b.kind === "turn-changes") {
    // A card's id is its checkpoint, and a captured turn's files never change.
    return true;
  }
  return false;
}

function areMeasuredTimelineItemPropsEqual(
  prev: MeasuredTimelineItemProps,
  next: MeasuredTimelineItemProps,
): boolean {
  return (
    isSameDisplayItem(prev.item, next.item) &&
    prev.className === next.className &&
    prev.top === next.top &&
    prev.generation === next.generation &&
    prev.onHeightChange === next.onHeightChange &&
    prev.expandedToolCallIds === next.expandedToolCallIds &&
    prev.onToggleToolCall === next.onToggleToolCall &&
    prev.onViewFileInDiff === next.onViewFileInDiff &&
    prev.onOpenTurnChange === next.onOpenTurnChange &&
    prev.sourceMessageIndex === next.sourceMessageIndex &&
    prev.onForkFromMessage === next.onForkFromMessage &&
    prev.onOpenWorkspaceFileLine === next.onOpenWorkspaceFileLine &&
    prev.workspacePath === next.workspacePath &&
    prev.scheduledOrigin?.taskId === next.scheduledOrigin?.taskId
  );
}

const MeasuredTimelineItem = memo(MeasuredTimelineItemBase, areMeasuredTimelineItemPropsEqual);
