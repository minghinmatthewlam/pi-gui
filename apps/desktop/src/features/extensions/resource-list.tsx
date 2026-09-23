import { useState, type ReactNode } from "react";
import { SettingsSwitch } from "../settings/settings-controls";

export interface ResourceListItem {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly enabled: boolean;
  /** Undefined when pi cannot change this item, such as a built-in extension. */
  readonly onToggle?: (enabled: boolean) => void;
}

export interface ResourceListGroup {
  readonly label: string;
  readonly items: readonly ResourceListItem[];
}

const COLLAPSED_ROW_COUNT = 6;

/** Cursor-style groups of Codex-style rows: icon tile, name, one-line description, switch. */
export function ResourceList({
  groups,
  icon,
  expanded,
  testId,
  onOpen,
}: {
  readonly groups: readonly ResourceListGroup[];
  readonly icon: ReactNode;
  /** Show every row, as while searching. */
  readonly expanded: boolean;
  readonly testId: string;
  readonly onOpen: (id: string) => void;
}) {
  return (
    <div className="resource-list" data-testid={testId}>
      {groups.map((group) => (
        <ResourceGroup
          expanded={expanded}
          group={group}
          icon={icon}
          key={group.label}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function ResourceGroup({
  group,
  icon,
  expanded,
  onOpen,
}: {
  readonly group: ResourceListGroup;
  readonly icon: ReactNode;
  readonly expanded: boolean;
  readonly onOpen: (id: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = expanded || showAll ? group.items : group.items.slice(0, COLLAPSED_ROW_COUNT);
  const hiddenCount = group.items.length - visible.length;

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">
        {group.label} <span className="resource-list__count">{group.items.length}</span>
      </h3>
      <div className="settings-group">
        {visible.map((item) => (
          <div className="resource-row" key={item.id}>
            <button className="resource-row__main" type="button" onClick={() => onOpen(item.id)}>
              <span className="resource-row__icon" aria-hidden="true">
                {icon}
              </span>
              <span className="resource-row__text">
                <span className="resource-row__title">{item.title}</span>
                <span className="resource-row__description">{item.description}</span>
              </span>
            </button>
            <SettingsSwitch
              checked={item.enabled}
              disabled={!item.onToggle}
              label={`Enable ${item.title}`}
              onChange={(enabled) => item.onToggle?.(enabled)}
            />
          </div>
        ))}
      </div>
      {hiddenCount > 0 ? (
        <button className="resource-list__more" type="button" onClick={() => setShowAll(true)}>
          Show {hiddenCount} more
        </button>
      ) : null}
    </section>
  );
}

export function ResourceEmptyState({
  title,
  body,
}: {
  readonly title: string;
  readonly body: string;
}) {
  return (
    <div className="settings-group resource-empty">
      <div className="resource-empty__title">{title}</div>
      <p className="resource-empty__body">{body}</p>
    </div>
  );
}
