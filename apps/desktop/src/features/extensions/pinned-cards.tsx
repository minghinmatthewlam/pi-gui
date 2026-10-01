import { useCallback, useMemo, useState } from "react";
import type { SessionTranscriptPin } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../../contracts/timeline-types";
import { ExtensionCardItem, type RunExtensionAction } from "../conversation/extension-card";
import { ChevronDownIcon, ChevronRightIcon, CloseIcon } from "../../ui/icons";
import { focusComposerAfter } from "./focus-composer";
import { splitPinnedCards, visiblePinnedCards, type PinnedCard } from "./pinned-cards-model";

export type { PinnedCard } from "./pinned-cards-model";

/**
 * Splits the selected thread's pins off its transcript and keeps which ones the user hid or
 * collapsed. Both live here at app level, keyed by thread and pin, so they survive switching
 * threads. A hidden pin remembers the write it hid; the extension writing it again shows it.
 */
export function usePinnedCards(sessionKey: string, transcript: readonly TranscriptMessage[]) {
  const [dismissedAt, setDismissedAt] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const { timeline, pins } = useMemo(() => splitPinnedCards(transcript), [transcript]);
  const visiblePins = useMemo(
    () =>
      visiblePinnedCards(
        pins,
        (pin) => dismissedAt.get(pinStateKey(sessionKey, pin)) === pin.createdAt,
      ),
    [dismissedAt, pins, sessionKey],
  );
  const collapsedPinIds = useMemo(
    () =>
      new Set(
        visiblePins.flatMap((pin) => (collapsed.has(pinStateKey(sessionKey, pin)) ? [pin.id] : [])),
      ),
    [collapsed, sessionKey, visiblePins],
  );
  const dismissPin = useCallback(
    (pin: PinnedCard) =>
      setDismissedAt((current) =>
        new Map(current).set(pinStateKey(sessionKey, pin), pin.createdAt),
      ),
    [sessionKey],
  );
  const togglePin = useCallback(
    (pin: PinnedCard) =>
      setCollapsed((current) => {
        const key = pinStateKey(sessionKey, pin);
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [sessionKey],
  );
  return { timeline, visiblePins, collapsedPinIds, dismissPin, togglePin };
}

function pinStateKey(sessionKey: string, pin: SessionTranscriptPin): string {
  return `${sessionKey}\u0000${pin.id}`;
}

/** Cards an extension pinned with `pi.appendEntry("pi-gui.pin", ...)`, stacked above the composer. */
export function PinnedCards({
  pins,
  collapsedPinIds,
  onToggle,
  onDismiss,
  onAction,
}: {
  readonly pins: readonly PinnedCard[];
  readonly collapsedPinIds: ReadonlySet<string>;
  readonly onToggle: (pin: PinnedCard) => void;
  readonly onDismiss: (pin: PinnedCard) => void;
  readonly onAction: RunExtensionAction;
}) {
  if (pins.length === 0) return null;
  return (
    <div className="pinned-cards" data-testid="pinned-cards">
      {pins.map((pin) => {
        const collapsed = collapsedPinIds.has(pin.id);
        const canCollapse = pin.card.rows.length > 0 || pin.card.actions.length > 0;
        return (
          <ExtensionCardItem
            key={pin.id}
            card={pin.card}
            collapsed={collapsed}
            onAction={onAction}
            controls={
              <span className="pinned-card__controls">
                {canCollapse ? (
                  <button
                    aria-expanded={!collapsed}
                    aria-label={`${collapsed ? "Expand" : "Collapse"} ${pin.card.title}`}
                    className="pinned-card__control icon-button"
                    data-testid="pinned-card-toggle"
                    title={collapsed ? "Expand" : "Collapse"}
                    type="button"
                    onClick={() => onToggle(pin)}
                  >
                    {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
                  </button>
                ) : null}
                <button
                  aria-label={`Hide ${pin.card.title}`}
                  className="pinned-card__control icon-button"
                  data-testid="pinned-card-dismiss"
                  title="Hide until it changes"
                  type="button"
                  onClick={(event) => focusComposerAfter(event.currentTarget, () => onDismiss(pin))}
                >
                  <CloseIcon />
                </button>
              </span>
            }
          />
        );
      })}
    </div>
  );
}
