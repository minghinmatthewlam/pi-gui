import type {
  ModelSettingsSnapshot,
  RuntimeSettingsSnapshot,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import type { DesktopAppState, WorkspaceRecord } from "./desktop-state";
import { resolveRepoWorkspaceId } from "./workspace-roots";

export function toModelSettingsSnapshot(
  settings: RuntimeSettingsSnapshot | ModelSettingsSnapshot,
): ModelSettingsSnapshot {
  return {
    ...(settings.defaultProvider ? { defaultProvider: settings.defaultProvider } : {}),
    ...(settings.defaultModelId ? { defaultModelId: settings.defaultModelId } : {}),
    ...(settings.defaultThinkingLevel
      ? { defaultThinkingLevel: settings.defaultThinkingLevel }
      : {}),
    enabledModelPatterns: [...settings.enabledModelPatterns],
  };
}

export function applyModelSettings(
  runtime: RuntimeSnapshot | undefined,
  modelSettings: ModelSettingsSnapshot | undefined,
): RuntimeSnapshot | undefined {
  if (!runtime) {
    return undefined;
  }
  if (!modelSettings) {
    return runtime;
  }
  return {
    ...runtime,
    settings: {
      ...runtime.settings,
      ...(modelSettings.defaultProvider
        ? { defaultProvider: modelSettings.defaultProvider }
        : { defaultProvider: undefined }),
      ...(modelSettings.defaultModelId
        ? { defaultModelId: modelSettings.defaultModelId }
        : { defaultModelId: undefined }),
      ...(modelSettings.defaultThinkingLevel
        ? { defaultThinkingLevel: modelSettings.defaultThinkingLevel }
        : { defaultThinkingLevel: undefined }),
      enabledModelPatterns: [...modelSettings.enabledModelPatterns],
    },
  };
}

export function resolveModelSettingsOwnerId(
  state: Pick<DesktopAppState, "modelSettingsScopeMode" | "workspaces">,
  workspaceId: string | undefined,
): string | undefined {
  if (!workspaceId) {
    return undefined;
  }
  if (state.modelSettingsScopeMode !== "per-repo") {
    return workspaceId;
  }
  return resolveRepoWorkspaceId(state.workspaces, workspaceId) ?? workspaceId;
}

export function getEffectiveModelRuntime(
  state: Pick<
    DesktopAppState,
    "runtimeByWorkspace" | "modelSettingsScopeMode" | "globalModelSettings" | "workspaces"
  >,
  workspace: WorkspaceRecord | undefined,
): RuntimeSnapshot | undefined {
  if (!workspace) {
    return undefined;
  }
  const runtime = state.runtimeByWorkspace[workspace.id];
  if (!runtime) {
    return undefined;
  }
  if (state.modelSettingsScopeMode === "app-global") {
    return applyModelSettings(runtime, state.globalModelSettings);
  }
  return runtime;
}
