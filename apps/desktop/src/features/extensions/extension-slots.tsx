import { useCallback } from "react";
import type {
  ExtensionAction,
  ExtensionBadge,
  ExtensionPanel,
  ExtensionTone,
  SessionRef,
} from "@pi-gui/session-driver";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type { WorkspaceFileLine } from "../conversation/workspace-file-line";
import { ExtensionIcon } from "../../ui/icons";

// Prototype: Tier 1 slots (panel tab, thread badge) and the fixed set of actions a slot button
// can ask the host for. Every action kind maps to one host behaviour; there is no other channel.

export type RunExtensionAction = (action: ExtensionAction) => void;

export function useExtensionSlotActions({
  api,
  target,
  openWorkspaceFileLine,
  setComposerDraft,
  openPanel,
}: {
  readonly api: PiDesktopApi | undefined;
  readonly target: SessionRef | null;
  readonly openWorkspaceFileLine: (target: WorkspaceFileLine) => void;
  readonly setComposerDraft: (text: string) => void;
  readonly openPanel: (panelKey: string) => void;
}): RunExtensionAction {
  return useCallback(
    (action: ExtensionAction) => {
      switch (action.type) {
        case "openFile":
          openWorkspaceFileLine({
            path: action.path,
            line: action.line ?? 1,
            endLine: action.line ?? 1,
          });
          return;
        case "composer":
          setComposerDraft(action.text);
          document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')?.focus();
          return;
        case "url":
          void api?.openExternal(action.url).catch((error: unknown) => {
            console.error("[renderer] openExternal failed", error);
          });
          return;
        case "command":
          // Runs the extension's own slash command; the driver never starts a model turn for it.
          if (!target) return;
          void api?.submitComposer(action.command).catch((error: unknown) => {
            console.error("[renderer] extension command failed", error);
          });
          return;
        case "panel":
          openPanel(action.key);
          return;
        default:
          return;
      }
    },
    [api, target, openWorkspaceFileLine, setComposerDraft, openPanel],
  );
}

export function toneLabel(tone: ExtensionTone | undefined): string | undefined {
  switch (tone) {
    case "success":
      return "Passed";
    case "warning":
      return "Warning";
    case "error":
      return "Failed";
    default:
      return undefined;
  }
}

export function ExtensionActionButtons({
  actions,
  onAction,
  className,
}: {
  readonly actions: readonly ExtensionAction[];
  readonly onAction?: RunExtensionAction;
  readonly className?: string;
}) {
  if (actions.length === 0) return null;
  return (
    <span className={className ?? "extension-actions"}>
      {actions.map((action, index) => (
        <button
          type="button"
          className="extension-actions__button"
          key={`${action.type}:${action.label}:${index}`}
          disabled={!onAction}
          onClick={() => onAction?.(action)}
        >
          {action.label}
        </button>
      ))}
    </span>
  );
}

/** The side-panel tab drawn from a `pi-gui.panel` record. */
export function ExtensionDataPanel({
  panel,
  onAction,
}: {
  readonly panel: ExtensionPanel;
  readonly onAction?: RunExtensionAction;
}) {
  return (
    <section
      className="extension-panel"
      aria-label={panel.title}
      data-testid="extension-panel"
      data-panel-key={panel.key}
    >
      <header className="extension-panel__header">
        <span className="extension-panel__title">{panel.title}</span>
        <ExtensionActionButtons actions={panel.actions ?? []} onAction={onAction} />
      </header>
      {panel.sections.map((section, sectionIndex) => (
        <div className="extension-panel__section" key={`${section.title ?? ""}:${sectionIndex}`}>
          {section.title ? <h3 className="extension-panel__section-title">{section.title}</h3> : null}
          <ul className="extension-panel__rows">
            {section.rows.map((row, rowIndex) => (
              <li
                className={`extension-panel__row${row.tone ? ` extension-panel__row--${row.tone}` : ""}`}
                key={`${row.label}:${rowIndex}`}
              >
                <span className="extension-panel__label">{row.label}</span>
                {row.value ? <span className="extension-panel__value">{row.value}</span> : null}
                {row.tone && toneLabel(row.tone) ? (
                  <span className="extension-panel__tone">{toneLabel(row.tone)}</span>
                ) : null}
                <ExtensionActionButtons
                  actions={row.actions ?? []}
                  onAction={onAction}
                  className="extension-actions extension-actions--row"
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** The chip drawn from a `pi-gui.badge` record, on the thread header and the sidebar row. */
export function ExtensionBadgeChip({
  badge,
  compact = false,
}: {
  readonly badge: ExtensionBadge;
  readonly compact?: boolean;
}) {
  return (
    <span
      className={`extension-badge extension-badge--${badge.tone ?? "neutral"}${compact ? " extension-badge--compact" : ""}`}
      data-testid="extension-badge"
      title={badge.text}
    >
      {compact ? null : (
        <span className="extension-badge__icon" aria-hidden="true">
          <ExtensionIcon />
        </span>
      )}
      {badge.text}
    </span>
  );
}

export function firstBadge(badges: readonly ExtensionBadge[] | undefined): ExtensionBadge | undefined {
  return badges?.[0];
}
