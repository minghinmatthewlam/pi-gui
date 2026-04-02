import type { WorkspaceRef } from "./types.js";

export type RuntimeAuthType = "oauth" | "api_key" | "none";
export type RuntimeProviderAuthSource = "none" | "oauth" | "auth_file" | "env" | "external";
export type RuntimeSourceScope = "user" | "project" | "temporary";
export type RuntimeSourceOrigin = "package" | "top-level";
export type RuntimeCommandSource = "extension" | "prompt" | "skill";

export interface RuntimeSourceInfo {
  readonly path: string;
  readonly source: string;
  readonly scope: RuntimeSourceScope;
  readonly origin: RuntimeSourceOrigin;
  readonly baseDir?: string;
}

export interface RuntimeProviderRecord {
  readonly id: string;
  readonly name: string;
  readonly hasAuth: boolean;
  readonly authType: RuntimeAuthType;
  readonly authSource: RuntimeProviderAuthSource;
  readonly oauthSupported: boolean;
  readonly apiKeySetupSupported: boolean;
}

export interface RuntimeModelRecord {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly label: string;
  readonly available: boolean;
  readonly authType: RuntimeAuthType;
  readonly reasoning: boolean;
  readonly supportsImages: boolean;
}

export interface RuntimeSkillRecord {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly baseDir: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly disableModelInvocation: boolean;
  readonly slashCommand: string;
}

export interface RuntimeExtensionDiagnostic {
  readonly type: "warning" | "error" | "collision";
  readonly message: string;
  readonly path?: string;
}

export interface RuntimeExtensionRecord {
  readonly path: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly sourceInfo: RuntimeSourceInfo;
  readonly commands: readonly string[];
  readonly tools: readonly string[];
  readonly flags: readonly string[];
  readonly shortcuts: readonly string[];
  readonly diagnostics: readonly RuntimeExtensionDiagnostic[];
}

export interface RuntimeCommandRecord {
  readonly name: string;
  readonly description?: string;
  readonly source: RuntimeCommandSource;
  readonly sourceInfo: RuntimeSourceInfo;
}

export function normalizeRuntimeCommandName(value: string): string {
  return value.trim().replace(/^\/+/, "");
}

export function runtimeCommandToken(name: string): string {
  return `/${normalizeRuntimeCommandName(name)}`;
}

export function skillCommandName(name: string): string {
  return `skill:${normalizeRuntimeCommandName(name)}`;
}

export function skillSlashCommand(name: string): string {
  return runtimeCommandToken(skillCommandName(name));
}

export interface RuntimeSettingsSnapshot {
  readonly defaultProvider?: string;
  readonly defaultModelId?: string;
  readonly defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly enableSkillCommands: boolean;
  readonly enabledModelPatterns: readonly string[];
}

export interface ModelSettingsSnapshot {
  readonly defaultProvider?: string;
  readonly defaultModelId?: string;
  readonly defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly enabledModelPatterns: readonly string[];
}

export interface RuntimeSnapshot {
  readonly workspace: WorkspaceRef;
  readonly providers: readonly RuntimeProviderRecord[];
  readonly models: readonly RuntimeModelRecord[];
  readonly skills: readonly RuntimeSkillRecord[];
  readonly extensions: readonly RuntimeExtensionRecord[];
  readonly settings: RuntimeSettingsSnapshot;
}

export interface RuntimeLoginAuthInfo {
  readonly url: string;
  readonly instructions?: string;
}

export interface RuntimeLoginPrompt {
  readonly message: string;
  readonly placeholder?: string;
  readonly allowEmpty?: boolean;
}

export interface RuntimeLoginCallbacks {
  readonly onAuth: (info: RuntimeLoginAuthInfo) => void | Promise<void>;
  readonly onPrompt: (prompt: RuntimeLoginPrompt) => Promise<string>;
  readonly onProgress?: (message: string) => void | Promise<void>;
  readonly onManualCodeInput?: () => Promise<string>;
  readonly signal?: AbortSignal;
}

export interface RuntimeResourceDriver {
  getRuntimeSnapshot(workspace: WorkspaceRef): Promise<RuntimeSnapshot>;
  refreshRuntime(workspace: WorkspaceRef): Promise<RuntimeSnapshot>;
  login(workspace: WorkspaceRef, providerId: string, callbacks: RuntimeLoginCallbacks): Promise<RuntimeSnapshot>;
  logout(workspace: WorkspaceRef, providerId: string): Promise<RuntimeSnapshot>;
  setProviderApiKey(workspace: WorkspaceRef, providerId: string, apiKey: string): Promise<RuntimeSnapshot>;
  setDefaultModel(
    workspace: WorkspaceRef,
    selection: {
      readonly provider: string;
      readonly modelId: string;
    },
  ): Promise<RuntimeSnapshot>;
  setDefaultThinkingLevel(
    workspace: WorkspaceRef,
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ): Promise<RuntimeSnapshot>;
  setEnableSkillCommands(workspace: WorkspaceRef, enabled: boolean): Promise<RuntimeSnapshot>;
  setScopedModelPatterns(workspace: WorkspaceRef, patterns: readonly string[]): Promise<RuntimeSnapshot>;
  setSkillEnabled(workspace: WorkspaceRef, filePath: string, enabled: boolean): Promise<RuntimeSnapshot>;
  setExtensionEnabled(workspace: WorkspaceRef, filePath: string, enabled: boolean): Promise<RuntimeSnapshot>;
}
