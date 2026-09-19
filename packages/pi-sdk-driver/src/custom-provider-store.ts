import { readFile } from "node:fs/promises";
import { writeJsonFileAtomic } from "@pi-gui/catalogs/node/atomic-write";
import {
  BUILT_IN_PROVIDER_IDS,
  CUSTOM_PROVIDER_ID_PATTERN,
  CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
  isValidHttpBaseUrl,
  OPENAI_COMPLETIONS_API,
  PI_GUI_CUSTOM_PROVIDER_MARKER,
  type CustomProviderEntry,
  type CustomProviderInput,
  type CustomProviderModelInput,
} from "./custom-provider-types.js";

export type {
  CustomProviderEntry,
  CustomProviderInput,
  CustomProviderModelInput,
} from "./custom-provider-types.js";
export {
  BUILT_IN_PROVIDER_IDS,
  CUSTOM_PROVIDER_ID_PATTERN,
  CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
  isValidHttpBaseUrl,
  OPENAI_COMPLETIONS_API,
  PI_GUI_CUSTOM_PROVIDER_MARKER,
} from "./custom-provider-types.js";

interface ModelsJson extends Record<string, unknown> {
  providers?: Record<string, unknown>;
}

export class CustomProviderStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly modelsJsonPath: string) {}

  async list(): Promise<readonly CustomProviderEntry[]> {
    return this.enqueue(async () => {
      const data = await readModelsJson(this.modelsJsonPath);
      return readCustomProviders(data);
    });
  }

  async set(input: CustomProviderInput): Promise<void> {
    validateInput(input);
    await this.enqueue(async () => {
      const data = await readModelsJson(this.modelsJsonPath);
      const providers = ensureProvidersRecord(data);
      const existing = providers[input.providerId];
      if (
        Object.hasOwn(providers, input.providerId) &&
        (!isRecord(existing) || !isPiGuiCustomProviderConfig(input.providerId, existing))
      ) {
        throw new Error(
          `Provider ID "${input.providerId}" already exists in models.json and is not managed by pi-gui.`,
        );
      }
      providers[input.providerId] = toProviderConfig(input);
      await atomicWriteJson(this.modelsJsonPath, data);
    });
  }

  async delete(providerId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const data = await readModelsJson(this.modelsJsonPath);
      const providers = data.providers;
      if (!providers || !Object.hasOwn(providers, providerId)) {
        return false;
      }
      const existing = providers[providerId];
      if (!isRecord(existing) || !isPiGuiCustomProviderConfig(providerId, existing)) {
        return false;
      }
      delete providers[providerId];
      await atomicWriteJson(this.modelsJsonPath, data);
      return true;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function validateInput(input: CustomProviderInput): void {
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(input.providerId)) {
    throw new Error(
      `Provider ID must be lowercase alphanumerics or dashes (max 64 chars): ${JSON.stringify(input.providerId)}`,
    );
  }
  if (!isValidHttpBaseUrl(input.baseUrl)) {
    throw new Error(
      `Base URL must start with http:// or https://: ${JSON.stringify(input.baseUrl)}`,
    );
  }
  if (input.models.length === 0) {
    throw new Error("At least one model is required.");
  }
  for (const model of input.models) {
    if (!model.id || typeof model.id !== "string") {
      throw new Error("Model id is required.");
    }
    if (model.contextWindow !== undefined && !Number.isFinite(model.contextWindow)) {
      throw new Error(`Model ${model.id} has non-numeric contextWindow.`);
    }
  }
}

function toProviderConfig(input: CustomProviderInput): Record<string, unknown> {
  const trimmedKey = input.apiKey?.trim();
  return {
    baseUrl: input.baseUrl,
    api: OPENAI_COMPLETIONS_API,
    apiKey: trimmedKey ? trimmedKey : CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
    [PI_GUI_CUSTOM_PROVIDER_MARKER]: true,
    models: input.models.map((model) => {
      const entry: Record<string, unknown> = { id: model.id };
      if (model.contextWindow !== undefined) {
        entry.contextWindow = model.contextWindow;
      }
      return entry;
    }),
  };
}

function readCustomProviders(data: ModelsJson): readonly CustomProviderEntry[] {
  const providers = data.providers;
  if (!providers) {
    return [];
  }
  const entries: CustomProviderEntry[] = [];
  for (const [providerId, rawConfig] of Object.entries(providers)) {
    if (!isRecord(rawConfig)) {
      continue;
    }
    const config = rawConfig;
    if (!isPiGuiCustomProviderConfig(providerId, config)) {
      continue;
    }
    const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : undefined;
    if (!baseUrl) {
      continue;
    }
    const models = Array.isArray(config.models)
      ? (config.models as unknown[])
          .map((raw): CustomProviderModelInput | undefined => {
            if (!raw || typeof raw !== "object") {
              return undefined;
            }
            const modelConfig = raw as Record<string, unknown>;
            if (typeof modelConfig.id !== "string" || !modelConfig.id) {
              return undefined;
            }
            const contextWindow =
              typeof modelConfig.contextWindow === "number" ? modelConfig.contextWindow : undefined;
            return contextWindow !== undefined
              ? { id: modelConfig.id, contextWindow }
              : { id: modelConfig.id };
          })
          .filter((entry): entry is CustomProviderModelInput => entry !== undefined)
      : [];
    const rawApiKey = typeof config.apiKey === "string" ? config.apiKey : undefined;
    const apiKey = rawApiKey === CUSTOM_PROVIDER_PLACEHOLDER_API_KEY ? undefined : rawApiKey;
    entries.push({
      providerId,
      baseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
      models,
    });
  }
  entries.sort((left, right) => left.providerId.localeCompare(right.providerId));
  return entries;
}

function isPiGuiCustomProviderConfig(providerId: string, config: Record<string, unknown>): boolean {
  if (config[PI_GUI_CUSTOM_PROVIDER_MARKER] === true) {
    return true;
  }
  if (BUILT_IN_PROVIDER_IDS.has(providerId)) {
    return false;
  }
  return (
    config.api === OPENAI_COMPLETIONS_API &&
    typeof config.baseUrl === "string" &&
    Array.isArray(config.models) &&
    config.models.length > 0
  );
}

function ensureProvidersRecord(data: ModelsJson): Record<string, unknown> {
  return (data.providers ??= {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readModelsJson(path: string): Promise<ModelsJson> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }
    throw error;
  }
  if (text.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON. Fix or remove the file before editing custom endpoints from the app. (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`${path} must contain a JSON object at the top level.`);
  }
  if (Object.hasOwn(parsed, "providers") && !isRecord(parsed.providers)) {
    throw new Error(
      `${path} must contain a JSON object for providers. Existing data was not changed.`,
    );
  }
  return { ...parsed, ...(isRecord(parsed.providers) ? { providers: parsed.providers } : {}) };
}

async function atomicWriteJson(path: string, data: Record<string, unknown>): Promise<void> {
  await writeJsonFileAtomic(path, data);
}
