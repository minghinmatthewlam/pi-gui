import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CustomProviderStore } from "./custom-provider-store.js";
import type { RuntimeSupervisorOptions } from "./runtime-supervisor.js";

export interface RuntimeDependencies {
  readonly agentDir: string;
  readonly modelsJsonPath: string;
  readonly authPath: string;
  readonly customProviderStore: CustomProviderStore;
}

export function createRuntimeDependencies(
  options: RuntimeSupervisorOptions = {},
): RuntimeDependencies {
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const modelsJsonPath = join(agentDir, "models.json");
  const authPath = join(agentDir, "auth.json");
  const customProviderStore =
    options.customProviderStore ?? new CustomProviderStore(modelsJsonPath);
  return {
    agentDir,
    modelsJsonPath,
    authPath,
    customProviderStore,
  };
}
