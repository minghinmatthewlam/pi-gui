import {
  type ModelRuntime,
  resolveModelScopeWithDiagnostics,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeModelRecord, RuntimeModelScope } from "@pi-gui/session-driver/runtime-types";

type ModelKey = Pick<RuntimeModelRecord, "providerId" | "modelId">;

const keyOf = (providerId: string, modelId: string) => `${providerId}/${modelId}`;

/**
 * Resolves `enabledModels` with pi's own resolver, so globs, bare ids, fuzzy names and
 * `:thinking` suffixes enable the same models here as in pi.
 */
export async function resolveModelScopes(
  patterns: readonly string[],
  modelRuntime: ModelRuntime,
): Promise<(model: ModelKey) => RuntimeModelScope> {
  if (patterns.length === 0) {
    return () => "all";
  }
  const available = await modelRuntime.getAvailable();
  const ownEntries = new Set(available.map((model) => keyOf(model.provider, model.id)));
  const [enabled, matched] = await Promise.all([
    resolvedKeys(patterns, modelRuntime),
    resolvedKeys(
      patterns.filter((pattern) => !ownEntries.has(pattern)),
      modelRuntime,
    ),
  ]);
  return (model) => {
    const key = keyOf(model.providerId, model.modelId);
    if (matched.has(key)) return "matched";
    return enabled.has(key) ? "listed" : "off";
  };
}

async function resolvedKeys(
  patterns: readonly string[],
  modelRuntime: ModelRuntime,
): Promise<ReadonlySet<string>> {
  if (patterns.length === 0) {
    return new Set();
  }
  const { scopedModels } = await resolveModelScopeWithDiagnostics([...patterns], modelRuntime);
  return new Set(scopedModels.map(({ model }) => keyOf(model.provider, model.id)));
}
