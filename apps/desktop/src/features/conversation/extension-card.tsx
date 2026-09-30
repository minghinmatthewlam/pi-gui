import type { ExtensionCard, ExtensionCardTone } from "@pi-gui/session-driver";
import { ExtensionIcon } from "../../ui/icons";
import type { WorkspaceFileLine } from "./workspace-file-line";

/**
 * A card an extension declared with `pi.appendEntry("pi-gui.card", ...)`, drawn in the
 * "Edited N files" shell: tone as a word, rows and actions like file rows.
 */
export function ExtensionCardItem({
  card,
  onOpenWorkspaceFileLine,
}: {
  readonly card: ExtensionCard;
  readonly onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void;
}) {
  const toneLabel = cardToneLabel(card.tone);
  const hasBody = card.rows.length > 0 || card.actions.length > 0;
  return (
    <section
      className={`turn-changes extension-card extension-card--${card.tone}`}
      aria-label={card.title}
      data-testid="extension-card"
    >
      <header className="turn-changes__header">
        <span className="turn-changes__glyph" aria-hidden="true">
          <ExtensionIcon />
        </span>
        <div className="turn-changes__summary">
          <span className="turn-changes__title">{card.title}</span>
          {card.subtitle ? <span className="extension-card__subtitle">{card.subtitle}</span> : null}
        </div>
        {toneLabel ? <span className="extension-card__tone">{toneLabel}</span> : null}
      </header>
      {hasBody ? (
        <ul className="turn-changes__files">
          {card.rows.map((row, index) => (
            <li className="extension-card__row" key={`row:${index}`}>
              <span className="extension-card__label">{row.label}</span>
              <span className="extension-card__value">{row.value}</span>
            </li>
          ))}
          {card.actions.map((action, index) => {
            const target = action.line ? `${action.path}:${action.line}` : action.path;
            return (
              <li key={`action:${index}`}>
                <button
                  type="button"
                  className="turn-changes__file extension-card__action"
                  disabled={!onOpenWorkspaceFileLine}
                  title={target}
                  onClick={() =>
                    onOpenWorkspaceFileLine?.({
                      path: action.path,
                      line: action.line ?? 1,
                      endLine: action.line ?? 1,
                    })
                  }
                >
                  <span className="extension-card__label">{action.label}</span>
                  <span className="extension-card__action-target">{target}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function cardToneLabel(tone: ExtensionCardTone): string | undefined {
  switch (tone) {
    case "success":
      return "Passed";
    case "warning":
      return "Warning";
    case "error":
      return "Failed";
    case "neutral":
      return undefined;
  }
}
