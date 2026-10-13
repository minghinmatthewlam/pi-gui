import { Minimatch } from "minimatch";
import type {
  ModelSettingsSnapshot,
  RuntimeModelRecord,
  RuntimeSettingsSnapshot,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import type { DesktopAppState, WorkspaceRecord } from "../../../contracts/desktop-state";
import { resolveRepoWorkspaceId } from "../../../contracts/workspace-roots";

// Compiling a glob costs far more than matching it, and each pattern is checked against every
// model. Patterns come from the user's settings, so this stays small.
const compiledPatterns = new Map<string, Minimatch>();

/** Matches an `enabledModels` entry the way pi does, including globs like `openrouter/**`. */
export function modelMatchesPattern(model: RuntimeModelRecord, pattern: string): boolean {
  const fullId = `${model.providerId}/${model.modelId}`;
  if (pattern === fullId) return true;
  if (!/[*?[]/.test(pattern)) return false;
  let glob = compiledPatterns.get(pattern);
  if (!glob) {
    glob = new Minimatch(pattern.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, ""), {
      nocase: true,
    });
    compiledPatterns.set(pattern, glob);
  }
  return glob.match(fullId) || glob.match(model.modelId);
}

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
