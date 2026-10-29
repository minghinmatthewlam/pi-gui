import { useTranslation, type Translate } from "../../i18n";
import type { RuntimeSkillRecord } from "@pi-gui/session-driver/runtime-types";
import type { WorkspaceRecord } from "../../../contracts/desktop-state";
import { titleCase } from "../../lib/string-utils";
import { SkillIcon } from "../../ui/icons";
import { SettingsGroup, SettingsRow } from "../settings/settings-utils";
import { sourceScopeGroupLabel } from "./extension-display";
import { displayPath, ResourceDetail } from "./resource-detail";
import { ResourceEmptyState, ResourceList, type ResourceListGroup } from "./resource-list";

const GROUP_ORDER = ["project", "user", "temporary"] as const;

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
  const { t } = useTranslation();

  // The list stays mounted under an open detail so expanded groups, scroll and focus survive.
  const list =
    skills.length === 0 ? (
      <ResourceEmptyState
        title={searching ? t("ui.noSkillsMatch") : t("ui.noSkillsYet")}
        body={searching ? t("resources.skillSearchHint") : t("resources.skillEmptyHint")}
      />
    ) : (
      <ResourceList
        expanded={searching}
        groups={groupSkills(skills, onToggleSkill, t)}
        icon={<SkillIcon />}
        testId="skills-list"
        onOpen={onSelect}
      />
    );

  return (
    <>
      {selected ? (
        <ResourceDetail
          actions={
            <>
              <button
                className="button button--secondary"
                type="button"
                onClick={() => onOpenSkillFolder(selected.filePath)}
              >
                {t("ui.openFolder")}
              </button>
              <button
                className="button button--primary"
                type="button"
                onClick={() => onTrySkill(selected)}
              >
                {t("ui.try")}
              </button>
            </>
          }
          backLabel={t("ui.allSkills")}
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
              title={t("ui.slashCommand")}
              description={t("ui.typeItInTheComposerToRunTheSkill")}
            >
              <code className="resource-detail__code">{selected.slashCommand}</code>
            </SettingsRow>
            <SettingsRow
              title={t("ui.modelInvocation")}
              description={
                selected.disableModelInvocation
                  ? t("ui.onlyRunsWhenYouTypeItsSlashCommand")
                  : t("ui.piCanAlsoChooseThisSkillOnItsOwnWhenItFits")
              }
            >
              <span className="settings-row__value">
                {selected.disableModelInvocation ? t("ui.slashCommandOnly") : t("ui.automatic")}
              </span>
            </SettingsRow>
            <SettingsRow
              title={t("ui.location")}
              description={sourceScopeGroupLabel(selected.scope, t)}
            >
              <code className="resource-detail__code" title={selected.filePath}>
                {displayPath(selected.filePath, workspace.path)}
              </code>
            </SettingsRow>
          </SettingsGroup>
        </ResourceDetail>
      ) : null}
      <div hidden={Boolean(selected)}>{list}</div>
    </>
  );
}

function groupSkills(
  skills: readonly RuntimeSkillRecord[],
  onToggleSkill: (filePath: string, enabled: boolean) => void,
  t: Translate,
): readonly ResourceListGroup[] {
  return GROUP_ORDER.map((scope) => ({
    label: sourceScopeGroupLabel(scope, t),
    items: skills
      .filter((skill) => skill.scope === scope)
      .map((skill) => ({
        id: skill.filePath,
        title: titleCase(skill.name),
        description: skill.description,
        enabled: skill.enabled,
        onToggle: (enabled: boolean) => onToggleSkill(skill.filePath, enabled),
      })),
  })).filter((group) => group.items.length > 0);
}
