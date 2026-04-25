import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CUSTOM_PROVIDER_ID_PATTERN,
  CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
  isValidHttpBaseUrl,
  OPENAI_COMPLETIONS_API,
  type CustomProviderEntry,
  type CustomProviderInput,
  type CustomProviderModelInput,
} from "./custom-provider-types.js";

export type { CustomProviderEntry, CustomProviderInput, CustomProviderModelInput } from "./custom-provider-types.js";
export {
  CUSTOM_PROVIDER_ID_PATTERN,
  CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
  isValidHttpBaseUrl,
  OPENAI_COMPLETIONS_API,
} from "./custom-provider-types.js";

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
      providers[input.providerId] = toProviderConfig(input);
      await atomicWriteJson(this.modelsJsonPath, data);
    });
  }

  async delete(providerId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const data = await readModelsJson(this.modelsJsonPath);
      const providers = data.providers;
      if (!providers || typeof providers !== "object" || !(providerId in providers)) {
        return false;
      }
      delete (providers as Record<string, unknown>)[providerId];
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
    throw new Error(`Base URL must start with http:// or https://: ${JSON.stringify(input.baseUrl)}`);
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
    models: input.models.map((model) => {
      const entry: Record<string, unknown> = { id: model.id };
      if (model.contextWindow !== undefined) {
        entry.contextWindow = model.contextWindow;
      }
      return entry;
    }),
  };
}

function readCustomProviders(data: Record<string, unknown>): readonly CustomProviderEntry[] {
  const providers = data.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }
  const entries: CustomProviderEntry[] = [];
  for (const [providerId, rawConfig] of Object.entries(providers as Record<string, unknown>)) {
    if (!rawConfig || typeof rawConfig !== "object") {
      continue;
    }
    const config = rawConfig as Record<string, unknown>;
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

function ensureProvidersRecord(data: Record<string, unknown>): Record<string, unknown> {
  if (!data.providers || typeof data.providers !== "object") {
    data.providers = {};
  }
  return data.providers as Record<string, unknown>;
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readModelsJson(path: string): Promise<Record<string, unknown>> {
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object at the top level.`);
  }
  return parsed as Record<string, unknown>;
}

async function atomicWriteJson(path: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, payload, "utf8");
  await rename(tempPath, path);
}
