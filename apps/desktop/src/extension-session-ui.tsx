import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { HostUiResponse } from "@pi-gui/session-driver";
import { trapDialogFocus } from "./dialog-focus";
import { ChevronDownIcon, ChevronRightIcon } from "./icons";
import type { SessionExtensionDialogRecord, SessionExtensionUiStateRecord } from "./desktop-state";

const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const DOCK_SEGMENT_SEPARATOR = "--------------------";
const GENERIC_ACTIVE_LABEL = "Extension UI active";

interface ExtensionDockBlock {
  readonly key: string;
  readonly lines: readonly string[];
}

export interface ExtensionDockModel {
  readonly summaryText: string;
  readonly bodyText: string;
}

export function hasExtensionDockContent(uiState?: SessionExtensionUiStateRecord): boolean {
  if (!uiState) {
    return false;
  }

  return uiState.statuses.length > 0 || uiState.widgets.length > 0;
}

export function buildExtensionDockModel(
  uiState?: SessionExtensionUiStateRecord,
): ExtensionDockModel | undefined {
  if (!hasExtensionDockContent(uiState)) {
    return undefined;
  }

  const statuses = (uiState?.statuses ?? [])
    .map((status) => ({
      key: status.key,
      text: sanitizeDockText(status.text),
    }))
    .filter((status) => status.text.trim().length > 0);
  const primaryBlocks = buildWidgetBlocks(uiState?.widgets ?? [], "aboveComposer");
  const secondaryBlocks = buildWidgetBlocks(uiState?.widgets ?? [], "belowComposer");
  const summaryText = resolveDockSummaryText(statuses, primaryBlocks, secondaryBlocks);

  return {
    summaryText,
    bodyText: buildDockBodyText(statuses, primaryBlocks, secondaryBlocks),
  };
}

export function ExtensionDock({
  dock,
  expanded,
  onToggle,
}: {
  readonly dock: ExtensionDockModel;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div
      className={`extension-dock ${expanded ? "extension-dock--expanded" : ""}`}
      data-testid="extension-dock"
    >
      <button
        aria-controls="extension-dock-body"
        aria-expanded={expanded}
        className="extension-dock__toggle"
        data-testid="extension-dock-toggle"
        title={dock.summaryText}
        type="button"
        onClick={onToggle}
      >
        <span className="extension-dock__summary" data-testid="extension-dock-summary">
          {dock.summaryText}
        </span>
        <span className="extension-dock__chevron" aria-hidden="true">
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </span>
      </button>
      {expanded ? (
        <pre
          className="extension-dock__body"
          data-testid="extension-dock-body"
          id="extension-dock-body"
        >
          {dock.bodyText}
        </pre>
      ) : null}
    </div>
  );
}

export function ExtensionDialog({
  dialog,
  onRespond,
}: {
  readonly dialog: SessionExtensionDialogRecord;
  readonly onRespond: (response: HostUiResponse) => void;
}) {
  const [draft, setDraft] = useState("");
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const firstOptionButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (dialog.kind === "input") {
      setDraft(dialog.initialValue ?? "");
      return;
    }
    if (dialog.kind === "editor") {
      setDraft(dialog.initialValue ?? "");
      return;
    }
    setDraft("");
  }, [dialog]);

  useEffect(() => {
    if (dialog.kind === "confirm") {
      cancelButtonRef.current?.focus();
      return;
    }
    if (dialog.kind === "select") {
      firstOptionButtonRef.current?.focus();
    }
  }, [dialog]);

  const respondWithCancel = () => onRespond({ requestId: dialog.requestId, cancelled: true });
  const respondWithSubmit = () => {
    if (dialog.kind === "confirm") {
      onRespond({ requestId: dialog.requestId, confirmed: true });
      return;
    }
    if (dialog.kind === "input" || dialog.kind === "editor") {
      onRespond({ requestId: dialog.requestId, value: draft });
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      trapDialogFocus(event, dialogRef.current);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      respondWithCancel();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      if (dialog.kind === "confirm" || dialog.kind === "input" || dialog.kind === "editor") {
        event.preventDefault();
        respondWithSubmit();
      }
    }
  };

  return (
    <div className="extension-dialog-backdrop">
      <div
        aria-describedby={dialog.kind === "confirm" ? bodyId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className="extension-dialog"
        data-testid="extension-dialog"
        ref={dialogRef}
        role="dialog"
        onKeyDown={handleKeyDown}
      >
        <div className="extension-dialog__title" id={titleId}>
          {dialog.title}
        </div>
        {dialog.kind === "confirm" ? (
          <p className="extension-dialog__body" id={bodyId}>
            {dialog.message}
          </p>
        ) : null}

        {dialog.kind === "select" ? (
          <div className="extension-dialog__options">
            {dialog.options.map((option, index) => (
              <button
                className="extension-dialog__option"
                key={option}
                ref={index === 0 ? firstOptionButtonRef : undefined}
                type="button"
                onClick={() => onRespond({ requestId: dialog.requestId, value: option })}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}

        {dialog.kind === "input" ? (
          <input
            autoFocus
            className="skills-search"
            placeholder={dialog.placeholder ?? "Enter a value"}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : null}

        {dialog.kind === "editor" ? (
          <textarea
            autoFocus
            className="extension-dialog__editor"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : null}

        <div className="extension-dialog__actions">
          <button
            ref={cancelButtonRef}
            className="button button--secondary"
            data-testid="extension-dialog-cancel"
            type="button"
            onClick={respondWithCancel}
          >
            Cancel
          </button>
          {dialog.kind === "confirm" ? (
            <button
              className="button button--primary"
              data-testid="extension-dialog-confirm"
              type="button"
              onClick={respondWithSubmit}
            >
              Confirm
            </button>
          ) : null}
          {dialog.kind === "input" || dialog.kind === "editor" ? (
            <button
              className="button button--primary"
              data-testid="extension-dialog-submit"
              type="button"
              onClick={respondWithSubmit}
            >
              Submit
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function buildWidgetBlocks(
  widgets: SessionExtensionUiStateRecord["widgets"],
  placement: "aboveComposer" | "belowComposer",
): ExtensionDockBlock[] {
  return widgets
    .filter((widget) => widget.placement === placement)
    .map((widget) => ({
      key: widget.key,
      lines: widget.lines.map((line) => sanitizeDockText(line)),
    }))
    .filter((widget) => widget.lines.some((line) => line.trim().length > 0));
}

function resolveDockSummaryText(
  statuses: readonly { readonly key: string; readonly text: string }[],
  primaryBlocks: readonly ExtensionDockBlock[],
  secondaryBlocks: readonly ExtensionDockBlock[],
): string {
  for (const status of statuses) {
    if (status.text.trim().length > 0) {
      return status.text;
    }
  }

  for (const block of [...primaryBlocks, ...secondaryBlocks]) {
    const summaryLine = block.lines.find((line) => line.trim().length > 0);
    if (summaryLine) {
      return summaryLine;
    }
  }

  return GENERIC_ACTIVE_LABEL;
}

function buildDockBodyText(
  statuses: readonly { readonly key: string; readonly text: string }[],
  primaryBlocks: readonly ExtensionDockBlock[],
  secondaryBlocks: readonly ExtensionDockBlock[],
): string {
  const totalBlocks = statuses.length + primaryBlocks.length + secondaryBlocks.length;
  const needsLabels = totalBlocks > 1;
  const primaryLines = [
    ...statuses.flatMap((status, index) => renderStatusBlock(status, needsLabels, index > 0)),
    ...primaryBlocks.flatMap((block, index) =>
      renderWidgetBlock(block, needsLabels, statuses.length + index > 0),
    ),
  ];
  const secondaryLines = secondaryBlocks.flatMap((block, index) =>
    renderWidgetBlock(block, needsLabels, index > 0),
  );

  if (secondaryLines.length === 0) {
    return primaryLines.join("\n");
  }

  if (primaryLines.length === 0) {
    return secondaryLines.join("\n");
  }

  return [...primaryLines, "", DOCK_SEGMENT_SEPARATOR, "", ...secondaryLines].join("\n");
}

function renderStatusBlock(
  status: { readonly key: string; readonly text: string },
  needsLabel: boolean,
  addLeadingGap: boolean,
): string[] {
  const lines = [`${needsLabel ? `${status.key}: ` : ""}${status.text}`];
  return addLeadingGap ? ["", ...lines] : lines;
}

function renderWidgetBlock(
  block: ExtensionDockBlock,
  needsLabel: boolean,
  addLeadingGap: boolean,
): string[] {
  const lines = needsLabel ? [`${block.key}:`, ...block.lines] : [...block.lines];
  return addLeadingGap ? ["", ...lines] : lines;
}

function sanitizeDockText(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(ANSI_ESCAPE_PATTERN, "");
}
