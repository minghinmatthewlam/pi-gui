import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
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
  // The palette and the workspace picker change what is listed without going through the tabs,
  // so a search or open detail from the previous list must not carry over.
  const listKey = `${tab}:${workspace?.id ?? ""}`;
  const [shownListKey, setShownListKey] = useState(listKey);
  if (shownListKey !== listKey) {
    setShownListKey(listKey);
    setQuery("");
    setSelectedId(undefined);
  }
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (selectedId || !returnFocusId.current) return;
    const id = returnFocusId.current;
    returnFocusId.current = undefined;
    panelRef.current?.querySelector<HTMLElement>(`[data-resource-id="${CSS.escape(id)}"]`)?.focus();
  }, [selectedId]);
  const selectItem = (id: string | undefined) => {
    if (id === undefined) returnFocusId.current = selectedId;
    setSelectedId(id);
  };
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

  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next: CustomizeTab = tab === "skills" ? "extensions" : "skills";
    onSelectTab(next);
    document.getElementById(tabId(next))?.focus();
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
          <div
            aria-label="Skills and extensions"
            className="resource-tabs"
            role="tablist"
            onKeyDown={handleTabKeyDown}
          >
            <ResourceTab
              count={skills.length}
              label="Skills"
              selected={tab === "skills"}
              tab="skills"
              onSelect={() => onSelectTab("skills")}
            />
            <ResourceTab
              count={extensions.length}
              label="Extensions"
              selected={tab === "extensions"}
              tab="extensions"
              onSelect={() => onSelectTab("extensions")}
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

        <div
          aria-labelledby={tabId(tab)}
          className="settings-grid"
          id={TAB_PANEL_ID}
          ref={panelRef}
          role="tabpanel"
        >
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
              onSelect={selectItem}
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
              onSelect={selectItem}
              onToggleExtension={onToggleExtension}
            />
          )}
        </div>
      </div>
    </section>
  );
}

const TAB_PANEL_ID = "customize-tab-panel";

function tabId(tab: CustomizeTab): string {
  return `customize-tab-${tab}`;
}

function ResourceTab({
  tab,
  label,
  count,
  selected,
  onSelect,
}: {
  readonly tab: CustomizeTab;
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      aria-controls={TAB_PANEL_ID}
      aria-selected={selected}
      className="resource-tabs__tab"
      id={tabId(tab)}
      role="tab"
      tabIndex={selected ? 0 : -1}
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
