import type { RuntimeExtensionRecord } from "@pi-gui/session-driver/runtime-types";
import type {
  ExtensionCommandCompatibilityRecord,
  WorkspaceRecord,
} from "../../../contracts/desktop-state";
import { ExtensionIcon } from "../../ui/icons";
import { SettingsGroup, SettingsRow } from "../settings/settings-utils";
import { extensionGroupLabel } from "./extension-display";
import { displayPath, ResourceDetail } from "./resource-detail";
import { ResourceEmptyState, ResourceList, type ResourceListGroup } from "./resource-list";

const GROUP_ORDER = ["Workspace", "User", "This session", "Built-in"];

interface ExtensionsTabProps {
  readonly workspace: WorkspaceRecord;
  readonly extensions: readonly RuntimeExtensionRecord[];
  readonly commandCompatibility: readonly ExtensionCommandCompatibilityRecord[];
  readonly searching: boolean;
  /** The extension whose detail page is open, looked up in the unfiltered list. */
  readonly selected?: RuntimeExtensionRecord;
  readonly onSelect: (path: string | undefined) => void;
  readonly onToggleExtension: (path: string, enabled: boolean) => void;
  readonly onOpenExtensionFolder: (path: string) => void;
}

export function ExtensionsTab({
  workspace,
  extensions,
  commandCompatibility,
  searching,
  selected,
  onSelect,
  onToggleExtension,
  onOpenExtensionFolder,
}: ExtensionsTabProps) {
  if (selected) {
    const manageable = isManageableExtension(selected);
    const compatibilityRecords = commandCompatibility
      .filter((record) => record.extensionPath === selected.path)
      .sort((left, right) => left.commandName.localeCompare(right.commandName));
    return (
      <ResourceDetail
        actions={
          manageable ? (
            <button
              className="button button--secondary"
              type="button"
              onClick={() => onOpenExtensionFolder(selected.path)}
            >
              Open folder
            </button>
          ) : null
        }
        backLabel="All extensions"
        enabled={selected.enabled}
        icon={<ExtensionIcon />}
        subtitle={selected.sourceInfo.source}
        title={selected.displayName}
        onBack={() => onSelect(undefined)}
        onToggle={manageable ? (enabled) => onToggleExtension(selected.path, enabled) : undefined}
      >
        {selected.description ? (
          <p className="resource-detail__description">{selected.description}</p>
        ) : null}
        <SettingsGroup>
          <SettingsRow
            title="Source"
            description={
              selected.sourceInfo.origin === "package"
                ? "Installed as a package"
                : "Loaded from a file"
            }
          >
            <span className="settings-row__value">{extensionGroupLabel(selected)}</span>
          </SettingsRow>
          {manageable ? (
            <SettingsRow title="Location">
              <code className="resource-detail__code" title={selected.path}>
                {displayPath(selected.path, workspace.path)}
              </code>
            </SettingsRow>
          ) : null}
        </SettingsGroup>
        <ExtensionContributionSection title="Tools" items={selected.tools} />
        {selected.commands.length > 0 ? (
          <ExtensionCompatibilitySection
            commands={selected.commands}
            compatibilityRecords={compatibilityRecords}
          />
        ) : null}
        <ExtensionContributionSection title="Flags" items={selected.flags} />
        <ExtensionContributionSection title="Shortcuts" items={selected.shortcuts} />
        <ExtensionDiagnostics diagnostics={selected.diagnostics} />
      </ResourceDetail>
    );
  }

  if (extensions.length === 0) {
    return (
      <ResourceEmptyState
        title={searching ? "No extensions match" : "No extensions yet"}
        body={
          searching
            ? "Try another name, command or tool."
            : "Extensions are discovered in this workspace and your user extension folders. Refresh after adding one."
        }
      />
    );
  }

  return (
    <ResourceList
      expanded={searching}
      groups={groupExtensions(extensions, onToggleExtension)}
      icon={<ExtensionIcon />}
      testId="extensions-list"
      onOpen={onSelect}
    />
  );
}

function groupExtensions(
  extensions: readonly RuntimeExtensionRecord[],
  onToggleExtension: (path: string, enabled: boolean) => void,
): readonly ResourceListGroup[] {
  return GROUP_ORDER.map((label) => ({
    label,
    items: extensions
      .filter((extension) => extensionGroupLabel(extension) === label)
      .map((extension) => ({
        id: extension.path,
        title: extension.displayName,
        description: describeExtension(extension),
        enabled: extension.enabled,
        onToggle: isManageableExtension(extension)
          ? (enabled: boolean) => onToggleExtension(extension.path, enabled)
          : undefined,
      })),
  })).filter((group) => group.items.length > 0);
}

/** One line for the list: the extension's own description, else what it contributes. */
function describeExtension(extension: RuntimeExtensionRecord): string {
  if (extension.description) return extension.description;
  const parts = [
    countLabel(extension.tools.length, "tool"),
    countLabel(extension.commands.length, "command"),
    countLabel(extension.diagnostics.length, "issue"),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : extension.sourceInfo.source;
}

function countLabel(count: number, noun: string): string {
  return count === 0 ? "" : `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function isManageableExtension(extension: RuntimeExtensionRecord): boolean {
  return extension.sourceInfo.scope === "project" || extension.sourceInfo.scope === "user";
}

function ExtensionContributionSection({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly string[];
}) {
  if (items.length === 0) return null;
  return (
    <SettingsGroup title={title}>
      <div className="resource-detail__tokens">
        {items.map((item) => (
          <code className="resource-detail__token" key={item}>
            {item}
          </code>
        ))}
      </div>
    </SettingsGroup>
  );
}

function ExtensionDiagnostics({
  diagnostics,
}: {
  readonly diagnostics: RuntimeExtensionRecord["diagnostics"];
}) {
  if (diagnostics.length === 0) return null;
  return (
    <SettingsGroup title="Diagnostics">
      {diagnostics.map((diagnostic, index) => (
        <div
          className={`activity-item activity-item--${diagnostic.type === "error" ? "error" : "info"}`}
          key={`${diagnostic.message}:${index}`}
        >
          <div className="activity-item__text">{diagnostic.message}</div>
          {diagnostic.path ? <div className="activity-item__meta">{diagnostic.path}</div> : null}
        </div>
      ))}
    </SettingsGroup>
  );
}

function ExtensionCompatibilitySection({
  commands,
  compatibilityRecords,
}: {
  readonly commands: readonly string[];
  readonly compatibilityRecords: readonly ExtensionCommandCompatibilityRecord[];
}) {
  const supported = compatibilityRecords.filter((record) => record.status === "supported");
  const terminalOnly = compatibilityRecords.filter((record) => record.status === "terminal-only");
  const unknown = commands.filter((commandName) =>
    compatibilityRecords.every(
      (record) =>
        record.commandName !== commandName && !record.commandName.startsWith(`${commandName}:`),
    ),
  );

  return (
    <SettingsGroup
      title="Commands"
      description="Whether each command works in the app is learned the first time it runs here."
    >
      <div className="resource-detail__tokens">
        {supported.map((record) => (
          <code className="resource-detail__token" key={`supported:${record.commandName}`}>
            {record.commandName} · GUI-compatible
          </code>
        ))}
        {terminalOnly.map((record) => (
          <code
            className="resource-detail__token resource-detail__token--warning"
            key={`terminal:${record.commandName}`}
          >
            {record.commandName} · Terminal-only
          </code>
        ))}
        {unknown.map((commandName) => (
          <code className="resource-detail__token" key={`unknown:${commandName}`}>
            {commandName} · Unknown
          </code>
        ))}
      </div>
    </SettingsGroup>
  );
}
