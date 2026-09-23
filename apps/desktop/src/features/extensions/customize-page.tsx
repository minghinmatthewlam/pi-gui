import { useMemo, useState, type ReactNode } from "react";
import type {
  RuntimeExtensionRecord,
  RuntimeSkillRecord,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import type {
  ExtensionCommandCompatibilityRecord,
  WorkspaceRecord,
} from "../../../contracts/desktop-state";
import { RefreshIcon, SearchIcon } from "../../ui/icons";
import { extensionScopeLabel } from "./extension-display";
import { ExtensionsTab } from "./extensions-view";
import { SkillsTab } from "./skills-view";

export type CustomizeTab = "skills" | "extensions";

interface CustomizePageProps {
  readonly tab: CustomizeTab;
  readonly onSelectTab: (tab: CustomizeTab) => void;
  /** The workspace the current tab lists; each tab remembers its own. */
  readonly workspace?: WorkspaceRecord;
  readonly workspacePicker: ReactNode;
  readonly skillsRuntime?: RuntimeSnapshot;
  readonly extensionsRuntime?: RuntimeSnapshot;
  readonly commandCompatibility: readonly ExtensionCommandCompatibilityRecord[];
  readonly onRefresh: () => void;
  readonly onToggleSkill: (filePath: string, enabled: boolean) => void;
  readonly onOpenSkillFolder: (filePath: string) => void;
  readonly onTryCommand: (command: string) => void;
  readonly onToggleExtension: (path: string, enabled: boolean) => void;
  readonly onOpenExtensionFolder: (path: string) => void;
}

const NEW_SKILL_PROMPT =
  "Create a new skill for this workspace and explain which files you will add.";

/** Codex's Plugins page: tabs with counts over one searchable, grouped list per tab. */
export function CustomizePage({
  tab,
  onSelectTab,
  workspace,
  workspacePicker,
  skillsRuntime,
  extensionsRuntime,
  commandCompatibility,
  onRefresh,
  onToggleSkill,
  onOpenSkillFolder,
  onTryCommand,
  onToggleExtension,
  onOpenExtensionFolder,
}: CustomizePageProps) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const skills = skillsRuntime?.skills ?? [];
  const extensions = extensionsRuntime?.extensions ?? [];
  const normalizedQuery = query.trim().toLowerCase();
  const filteredSkills = useMemo(
    () => skills.filter((skill) => matchesQuery(skillSearchText(skill), normalizedQuery)),
    [skills, normalizedQuery],
  );
  const filteredExtensions = useMemo(
    () =>
      extensions.filter((extension) =>
        matchesQuery(extensionSearchText(extension), normalizedQuery),
      ),
    [extensions, normalizedQuery],
  );

  const selectTab = (next: CustomizeTab) => {
    setQuery("");
    setSelectedId(undefined);
    onSelectTab(next);
  };

  return (
    <section className="canvas">
      <div className="conversation settings-view">
        <header className="view-header">
          <div>
            <h1 className="view-header__title">Skills and extensions</h1>
            <p className="view-header__body">
              Reusable workflows and runtime add-ons pi loads for{" "}
              {workspace?.name ?? "this workspace"}.
            </p>
          </div>
          <div className="view-header__actions">
            {workspacePicker}
            <button
              aria-label="Refresh"
              className="icon-button resource-refresh"
              title="Refresh"
              type="button"
              onClick={onRefresh}
            >
              <RefreshIcon />
            </button>
            {tab === "skills" && workspace ? (
              <button
                className="button button--primary"
                type="button"
                onClick={() => onTryCommand(NEW_SKILL_PROMPT)}
              >
                New skill
              </button>
            ) : null}
          </div>
        </header>

        <div className="resource-toolbar">
          <div aria-label="Skills and extensions" className="resource-tabs" role="tablist">
            <ResourceTab
              count={skills.length}
              label="Skills"
              selected={tab === "skills"}
              onSelect={() => selectTab("skills")}
            />
            <ResourceTab
              count={extensions.length}
              label="Extensions"
              selected={tab === "extensions"}
              onSelect={() => selectTab("extensions")}
            />
          </div>
          <label className="resource-search">
            <SearchIcon />
            <input
              aria-label={`Search ${tab}`}
              placeholder={`Search ${tab}`}
              spellCheck={false}
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setSelectedId(undefined);
              }}
            />
          </label>
        </div>

        <div className="settings-grid" role="tabpanel">
          {!workspace ? (
            <div className="settings-group resource-empty">
              <div className="resource-empty__title">Open a folder first</div>
              <p className="resource-empty__body">
                Skills and extensions are discovered per workspace, plus your user folders.
              </p>
            </div>
          ) : tab === "skills" ? (
            <SkillsTab
              searching={normalizedQuery.length > 0}
              selected={skills.find((skill) => skill.filePath === selectedId)}
              skills={filteredSkills}
              workspace={workspace}
              onOpenSkillFolder={onOpenSkillFolder}
              onSelect={setSelectedId}
              onToggleSkill={onToggleSkill}
              onTrySkill={(skill) => onTryCommand(`${skill.slashCommand} `)}
            />
          ) : (
            <ExtensionsTab
              commandCompatibility={commandCompatibility}
              extensions={filteredExtensions}
              searching={normalizedQuery.length > 0}
              selected={extensions.find((extension) => extension.path === selectedId)}
              workspace={workspace}
              onOpenExtensionFolder={onOpenExtensionFolder}
              onSelect={setSelectedId}
              onToggleExtension={onToggleExtension}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function ResourceTab({
  label,
  count,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      aria-selected={selected}
      className="resource-tabs__tab"
      role="tab"
      type="button"
      onClick={onSelect}
    >
      {label}
      <span className="resource-tabs__count">{count}</span>
    </button>
  );
}

function matchesQuery(text: string, normalizedQuery: string): boolean {
  return !normalizedQuery || text.includes(normalizedQuery);
}

function skillSearchText(skill: RuntimeSkillRecord): string {
  return [skill.name, skill.description, skill.source, skill.slashCommand].join(" ").toLowerCase();
}

function extensionSearchText(extension: RuntimeExtensionRecord): string {
  return [
    extension.displayName,
    extension.description ?? "",
    extension.path,
    extension.sourceInfo.source,
    extensionScopeLabel(extension),
    ...extension.commands,
    ...extension.tools,
    ...extension.flags,
    ...extension.shortcuts,
    ...extension.diagnostics.map((diagnostic) => diagnostic.message),
  ]
    .join(" ")
    .toLowerCase();
}
