export interface CustomProviderModelInput {
  readonly id: string;
  readonly contextWindow?: number;
}

export interface CustomProviderInput {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly CustomProviderModelInput[];
}

export interface CustomProviderEntry {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly CustomProviderModelInput[];
}

export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const OPENAI_COMPLETIONS_API = "openai-completions";

export const CUSTOM_PROVIDER_PLACEHOLDER_API_KEY = "unused";

export function isValidHttpBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.host.length > 0;
  } catch {
    return false;
  }
}
