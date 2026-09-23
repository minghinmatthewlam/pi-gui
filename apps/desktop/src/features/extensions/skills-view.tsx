import type { RuntimeSkillRecord } from "@pi-gui/session-driver/runtime-types";
import type { WorkspaceRecord } from "../../../contracts/desktop-state";
import { titleCase } from "../../lib/string-utils";
import { SkillIcon } from "../../ui/icons";
import { SettingsGroup, SettingsRow } from "../settings/settings-utils";
import { sourceScopeGroupLabel } from "./extension-display";
import { displayPath, ResourceDetail } from "./resource-detail";
import { ResourceEmptyState, ResourceList, type ResourceListGroup } from "./resource-list";

const GROUP_ORDER = ["Workspace", "User", "This session"];

interface SkillsTabProps {
  readonly workspace: WorkspaceRecord;
  readonly skills: readonly RuntimeSkillRecord[];
  readonly searching: boolean;
  /** The skill whose detail page is open, looked up in the unfiltered list. */
  readonly selected?: RuntimeSkillRecord;
  readonly onSelect: (filePath: string | undefined) => void;
  readonly onToggleSkill: (filePath: string, enabled: boolean) => void;
  readonly onOpenSkillFolder: (filePath: string) => void;
  readonly onTrySkill: (skill: RuntimeSkillRecord) => void;
}

export function SkillsTab({
  workspace,
  skills,
  searching,
  selected,
  onSelect,
  onToggleSkill,
  onOpenSkillFolder,
  onTrySkill,
}: SkillsTabProps) {
  if (selected) {
    return (
      <ResourceDetail
        actions={
          <>
            <button
              className="button button--secondary"
              type="button"
              onClick={() => onOpenSkillFolder(selected.filePath)}
            >
              Open folder
            </button>
            <button
              className="button button--primary"
              type="button"
              onClick={() => onTrySkill(selected)}
            >
              Try
            </button>
          </>
        }
        backLabel="All skills"
        enabled={selected.enabled}
        icon={<SkillIcon />}
        subtitle={selected.slashCommand}
        title={titleCase(selected.name)}
        onBack={() => onSelect(undefined)}
        onToggle={(enabled) => onToggleSkill(selected.filePath, enabled)}
      >
        <p className="resource-detail__description">{selected.description}</p>
        <SettingsGroup>
          <SettingsRow
            title="Slash command"
            description="Type it in the composer to run the skill."
          >
            <code className="resource-detail__code">{selected.slashCommand}</code>
          </SettingsRow>
          <SettingsRow
            title="Model invocation"
            description={
              selected.disableModelInvocation
                ? "Only runs when you type its slash command."
                : "pi can also choose this skill on its own when it fits the task."
            }
          >
            <span className="settings-row__value">
              {selected.disableModelInvocation ? "Slash command only" : "Automatic"}
            </span>
          </SettingsRow>
          <SettingsRow title="Location" description={sourceScopeGroupLabel(selected.scope)}>
            <code className="resource-detail__code" title={selected.filePath}>
              {displayPath(selected.filePath, workspace.path)}
            </code>
          </SettingsRow>
        </SettingsGroup>
      </ResourceDetail>
    );
  }

  if (skills.length === 0) {
    return (
      <ResourceEmptyState
        title={searching ? "No skills match" : "No skills yet"}
        body={
          searching
            ? "Try another name, description or slash command."
            : "Skills are discovered in this workspace and your user skill folders. Create one, or refresh after adding one."
        }
      />
    );
  }

  return (
    <ResourceList
      expanded={searching}
      groups={groupSkills(skills, onToggleSkill)}
      icon={<SkillIcon />}
      testId="skills-list"
      onOpen={onSelect}
    />
  );
}

function groupSkills(
  skills: readonly RuntimeSkillRecord[],
  onToggleSkill: (filePath: string, enabled: boolean) => void,
): readonly ResourceListGroup[] {
  return GROUP_ORDER.map((label) => ({
    label,
    items: skills
      .filter((skill) => sourceScopeGroupLabel(skill.scope) === label)
      .map((skill) => ({
        id: skill.filePath,
        title: titleCase(skill.name),
        description: skill.description,
        enabled: skill.enabled,
        onToggle: (enabled: boolean) => onToggleSkill(skill.filePath, enabled),
      })),
  })).filter((group) => group.items.length > 0);
}
