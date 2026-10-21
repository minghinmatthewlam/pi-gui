import { translate, type Translate } from "../../i18n";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import { buildModelOptions } from "../conversation/composer-commands";

export type ModelOnboardingSettingsSection = "models" | "providers";

export interface ModelOnboardingNotice {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly actionSection: ModelOnboardingSettingsSection;
}

export interface ModelOnboardingState {
  readonly hasSelectableModels: boolean;
  readonly requiresModelSelection: boolean;
  readonly unselectedModelLabel: string;
  readonly emptyModelTitle: string;
  readonly emptyModelDescription: string;
  readonly notice?: ModelOnboardingNotice;
}

interface ModelSelectionInput {
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
}

export function deriveModelOnboardingState(
  runtime: RuntimeSnapshot | undefined,
  currentSelection: ModelSelectionInput,
  t: Translate = translate,
): ModelOnboardingState {
  const selectableModels = buildModelOptions(runtime);
  const selectableSet = new Set(
    selectableModels.map((model) => `${model.providerId}:${model.modelId}`),
  );
  const hasSelectableModels = selectableModels.length > 0;
  const connectedProviderCount =
    runtime?.providers.filter((provider) => provider.hasAuth).length ?? 0;
  const settingsDefault = {
    provider: runtime?.settings.defaultProvider,
    modelId: runtime?.settings.defaultModelId,
  };
  const hasDefaultModel = Boolean(settingsDefault.provider && settingsDefault.modelId);
  const defaultModelUsable = isUsableSelection(settingsDefault, selectableSet);
  const hasCurrentSelection = Boolean(currentSelection.provider && currentSelection.modelId);
  const currentSelectionUsable = isUsableSelection(currentSelection, selectableSet);

  if (!hasSelectableModels) {
    return {
      hasSelectableModels: false,
      requiresModelSelection: true,
      unselectedModelLabel: t("models.noAvailable"),
      emptyModelTitle: t("models.noAvailable"),
      emptyModelDescription:
        connectedProviderCount > 0 ? t("models.enableHint") : t("models.connectHint"),
      notice:
        connectedProviderCount > 0
          ? {
              title: t("models.noAvailable"),
              description: t("models.disabledHint"),
              actionLabel: t("models.openModels"),
              actionSection: "models",
            }
          : {
              title: t("models.noAvailable"),
              description: t("models.noProviderHint"),
              actionLabel: t("models.openProviders"),
              actionSection: "providers",
            },
    };
  }

  if (hasCurrentSelection && !currentSelectionUsable) {
    return {
      hasSelectableModels: true,
      requiresModelSelection: true,
      unselectedModelLabel: t("models.pick"),
      emptyModelTitle: t("models.noAvailable"),
      emptyModelDescription: t("models.pickHint"),
      notice: {
        title: t("models.selectionUnavailable"),
        description: hasDefaultModel
          ? t("models.selectionUpdate")
          : t("models.selectionChooseDefault"),
        actionLabel: t("models.openModels"),
        actionSection: "models",
      },
    };
  }

  if (!hasDefaultModel) {
    return {
      hasSelectableModels: true,
      requiresModelSelection: !currentSelectionUsable,
      unselectedModelLabel: t("models.pick"),
      emptyModelTitle: t("models.noDefault"),
      emptyModelDescription: t("models.pickHint"),
      notice: currentSelectionUsable
        ? undefined
        : {
            title: t("models.noDefault"),
            description: t("models.setDefault"),
            actionLabel: t("models.openModels"),
            actionSection: "models",
          },
    };
  }

  if (!defaultModelUsable) {
    const defaultLabel = `${settingsDefault.provider}:${settingsDefault.modelId}`;
    return {
      hasSelectableModels: true,
      requiresModelSelection: !currentSelectionUsable,
      unselectedModelLabel: t("models.pick"),
      emptyModelTitle: t("models.defaultUnavailable"),
      emptyModelDescription: t("models.pickHint"),
      notice: {
        title: t("models.defaultUnavailable"),
        description: currentSelectionUsable
          ? t("models.defaultUpdate", { defaultLabel: defaultLabel })
          : t("models.defaultChooseUpdate", { defaultLabel: defaultLabel }),
        actionLabel: t("models.openModels"),
        actionSection: "models",
      },
    };
  }

  return {
    hasSelectableModels: true,
    requiresModelSelection: false,
    unselectedModelLabel: t("models.pick"),
    emptyModelTitle: t("models.noAvailable"),
    emptyModelDescription: t("models.pickHint"),
  };
}

function isUsableSelection(
  selection: ModelSelectionInput,
  selectableSet: ReadonlySet<string>,
): boolean {
  return Boolean(
    selection.provider &&
    selection.modelId &&
    selectableSet.has(`${selection.provider}:${selection.modelId}`),
  );
}
