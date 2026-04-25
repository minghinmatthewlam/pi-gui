import { join, resolve } from "node:path";
import { AuthStorage, ModelRegistry, getAgentDir } from "@mariozechner/pi-coding-agent";
import { CustomProviderStore } from "./custom-provider-store.js";
import type { RuntimeSupervisorOptions } from "./runtime-supervisor.js";

export interface RuntimeDependencies {
  readonly agentDir: string;
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  readonly customProviderStore: CustomProviderStore;
}

export function createRuntimeDependencies(options: RuntimeSupervisorOptions = {}): RuntimeDependencies {
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const modelsJsonPath = join(agentDir, "models.json");
  const authStorage = options.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsJsonPath);
  const customProviderStore = options.customProviderStore ?? new CustomProviderStore(modelsJsonPath);
  return {
    agentDir,
    authStorage,
    modelRegistry,
    customProviderStore,
  };
}
