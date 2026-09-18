import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import { buildModelOptions } from "./composer-commands";

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
      unselectedModelLabel: "No models available",
      emptyModelTitle: "No models available",
      emptyModelDescription:
        connectedProviderCount > 0
          ? "Open Settings > Models to enable models."
          : "Open Settings > Providers to connect a provider and make models available.",
      notice:
        connectedProviderCount > 0
          ? {
              title: "No models available",
              description:
                "All available models are currently disabled. Open Settings > Models to enable models.",
              actionLabel: "Open Settings > Models",
              actionSection: "models",
            }
          : {
              title: "No models available",
              description:
                "Connect a provider in Settings > Providers before choosing a model or setting a default.",
              actionLabel: "Open Settings > Providers",
              actionSection: "providers",
            },
    };
  }

  if (hasCurrentSelection && !currentSelectionUsable) {
    return {
      hasSelectableModels: true,
      requiresModelSelection: true,
      unselectedModelLabel: "Pick a model",
      emptyModelTitle: "No models available",
      emptyModelDescription: "Pick a model.",
      notice: {
        title: "Selected model unavailable",
        description: hasDefaultModel
          ? "The model selected for this thread is no longer available. Choose another model, then open Settings > Models to update the default."
          : "The model selected for this thread is no longer available. Choose another model, then open Settings > Models to choose the app default.",
        actionLabel: "Open Settings > Models",
        actionSection: "models",
      },
    };
  }

  if (!hasDefaultModel) {
    return {
      hasSelectableModels: true,
      requiresModelSelection: !currentSelectionUsable,
      unselectedModelLabel: "Pick a model",
      emptyModelTitle: "No default model set",
      emptyModelDescription: "Pick a model.",
      notice: currentSelectionUsable
        ? undefined
        : {
            title: "No default model set",
            description: "Set a default model in Settings > Models.",
            actionLabel: "Open Settings > Models",
            actionSection: "models",
          },
    };
  }

  if (!defaultModelUsable) {
    const defaultLabel = `${settingsDefault.provider}:${settingsDefault.modelId}`;
    return {
      hasSelectableModels: true,
      requiresModelSelection: !currentSelectionUsable,
      unselectedModelLabel: "Pick a model",
      emptyModelTitle: "Default model unavailable",
      emptyModelDescription: "Pick a model.",
      notice: {
        title: "Default model unavailable",
        description: currentSelectionUsable
          ? `Your saved default (${defaultLabel}) is no longer available. Open Settings > Models to update it.`
          : `Your saved default (${defaultLabel}) is no longer available. Choose a model for this thread, then open Settings > Models to update it.`,
        actionLabel: "Open Settings > Models",
        actionSection: "models",
      },
    };
  }

  return {
    hasSelectableModels: true,
    requiresModelSelection: false,
    unselectedModelLabel: "Pick a model",
    emptyModelTitle: "No models available",
    emptyModelDescription: "Pick a model.",
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
