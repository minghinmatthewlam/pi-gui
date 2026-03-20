import type { SessionConfig } from "@pi-app/session-driver";
import type { RuntimeProviderRecord, RuntimeSettingsSnapshot, RuntimeSkillRecord, RuntimeSnapshot } from "@pi-app/session-driver/runtime-types";

export type ComposerSlashCommandKind =
  | "model"
  | "thinking"
  | "status"
  | "session"
  | "reload"
  | "compact"
  | "name"
  | "login"
  | "logout"
  | "settings"
  | "scoped-models"
  | "skill";

export interface ComposerSlashCommand {
  readonly id: string;
  readonly kind: ComposerSlashCommandKind;
  readonly command: string;
  readonly template: string;
  readonly title: string;
  readonly description: string;
  readonly submitMode?: "immediate" | "prefill" | "pick-option";
  readonly section: "commands" | "skills";
  readonly skill?: RuntimeSkillRecord;
}

export interface ComposerSlashCommandSection {
  readonly id: "commands" | "skills";
  readonly title?: string;
  readonly items: readonly ComposerSlashCommand[];
}

export interface ComposerSlashOption {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

export interface ComposerModelOption extends ComposerSlashOption {
  readonly providerId: string;
  readonly modelId: string;
}

export interface ComposerProviderOption extends ComposerSlashOption {
  readonly providerId: string;
}

export type ParsedComposerCommand =
  | { type: "model"; provider: string; modelId: string }
  | { type: "thinking"; thinkingLevel: string }
  | { type: "status" }
  | { type: "session" }
  | { type: "reload" }
  | { type: "compact"; customInstructions?: string }
  | { type: "name"; title: string };

const BUILTIN_SLASH_COMMANDS: readonly ComposerSlashCommand[] = [
  {
    id: "model",
    kind: "model",
    command: "/model",
    template: "/model",
    title: "Model",
    description: "Choose the model for this session",
    submitMode: "pick-option",
    section: "commands",
  },
  {
    id: "thinking",
    kind: "thinking",
    command: "/thinking",
    template: "/thinking",
    title: "Reasoning",
    description: "Set thinking level for this session",
    submitMode: "pick-option",
    section: "commands",
  },
  {
    id: "status",
    kind: "status",
    command: "/status",
    template: "/status",
    title: "Status",
    description: "Show current session overrides in the timeline",
    submitMode: "immediate",
    section: "commands",
  },
  {
    id: "login",
    kind: "login",
    command: "/login",
    template: "/login",
    title: "Login",
    description: "Authenticate a provider for this workspace",
    submitMode: "pick-option",
    section: "commands",
  },
  {
    id: "logout",
    kind: "logout",
    command: "/logout",
    template: "/logout",
    title: "Logout",
    description: "Remove a provider login from this workspace",
    submitMode: "pick-option",
    section: "commands",
  },
  {
    id: "settings",
    kind: "settings",
    command: "/settings",
    template: "/settings",
    title: "Settings",
    description: "Open model, skill, and notification settings",
    submitMode: "immediate",
    section: "commands",
  },
  {
    id: "scoped-models",
    kind: "scoped-models",
    command: "/scoped-models",
    template: "/scoped-models",
    title: "Scoped models",
    description: "Manage the quick-cycle model shortlist",
    submitMode: "immediate",
    section: "commands",
  },
  {
    id: "session",
    kind: "session",
    command: "/session",
    template: "/session",
    title: "Session",
    description: "Show current session details in the timeline",
    submitMode: "immediate",
    section: "commands",
  },
  {
    id: "name",
    kind: "name",
    command: "/name",
    template: "/name New thread title",
    title: "Rename",
    description: "Rename the current session",
    submitMode: "prefill",
    section: "commands",
  },
  {
    id: "compact",
    kind: "compact",
    command: "/compact",
    template: "/compact",
    title: "Compact",
    description: "Compact session context now",
    submitMode: "immediate",
    section: "commands",
  },
  {
    id: "reload",
    kind: "reload",
    command: "/reload",
    template: "/reload",
    title: "Reload",
    description: "Reload prompts, skills, and session resources",
    submitMode: "immediate",
    section: "commands",
  },
] as const;

export const THINKING_OPTIONS: readonly ComposerSlashOption[] = [
  {
    value: "low",
    label: "Low",
    description: "Fast responses with lighter reasoning",
  },
  {
    value: "medium",
    label: "Medium",
    description: "Balances speed and reasoning depth for everyday tasks",
  },
  {
    value: "high",
    label: "High",
    description: "Greater reasoning depth for complex problems",
  },
  {
    value: "xhigh",
    label: "Extra High",
    description: "Extra high reasoning depth for complex problems",
  },
] as const;

export function buildSlashCommandSections(
  query: string,
  runtime?: RuntimeSnapshot,
): readonly ComposerSlashCommandSection[] {
  const normalizedQuery = query.trim().toLowerCase();
  const builtinMatches = BUILTIN_SLASH_COMMANDS.filter((command) => matchesCommand(command, normalizedQuery));
  const skillMatches = (runtime?.skills ?? [])
    .map<ComposerSlashCommand>((skill: RuntimeSkillRecord) => ({
      id: `skill:${skill.name}`,
      kind: "skill",
      command: skill.slashCommand,
      template: `${skill.slashCommand} `,
      title: titleCase(skill.name),
      description: skill.description,
      submitMode: "prefill",
      section: "skills",
      skill,
    }))
    .filter((command) => matchesCommand(command, normalizedQuery));

  const sections: ComposerSlashCommandSection[] = [
    {
      id: "commands",
      title: undefined,
      items: builtinMatches,
    },
    {
      id: "skills",
      title: skillMatches.length > 0 ? "Skills" : undefined,
      items: skillMatches,
    },
  ];

  return sections.filter((section) => section.items.length > 0);
}

export function findSlashSuggestions(
  query: string,
  runtime?: RuntimeSnapshot,
): readonly ComposerSlashCommandSection[] {
  return buildSlashCommandSections(query, runtime);
}

export function flattenSlashSections(
  sections: readonly ComposerSlashCommandSection[],
): readonly ComposerSlashCommand[] {
  return sections.flatMap((section) => section.items);
}

export function findExactSlashCommand(
  query: string,
  runtime?: RuntimeSnapshot,
): ComposerSlashCommand | undefined {
  return flattenSlashSections(buildSlashCommandSections(query, runtime)).find((command) =>
    isExactSlashCommand(query, command),
  );
}

export function buildProviderOptions(
  providers: readonly RuntimeProviderRecord[],
  filter: (provider: RuntimeProviderRecord) => boolean = () => true,
): readonly ComposerProviderOption[] {
  return providers
    .filter(filter)
    .map((provider) => ({
      value: provider.id,
      label: provider.name,
      description: describeProvider(provider),
      providerId: provider.id,
    }));
}

export function buildModelOptions(
  runtime: RuntimeSnapshot | undefined,
  providerId: string,
): readonly ComposerModelOption[] {
  if (!runtime) {
    return [];
  }

  return runtime.models
    .filter((model: RuntimeSnapshot["models"][number]) => model.providerId === providerId)
    .map((model: RuntimeSnapshot["models"][number]) => ({
      value: `${model.providerId}:${model.modelId}`,
      label: model.label,
      description: `${model.modelId}${model.available ? "" : " · unavailable"}`,
      providerId: model.providerId,
      modelId: model.modelId,
    }));
}

export function slashOptionsForCommand(
  command: ComposerSlashCommand | undefined,
  runtime?: RuntimeSnapshot,
): readonly ComposerSlashOption[] {
  if (!command) {
    return [];
  }

  if (command.kind === "thinking") {
    return THINKING_OPTIONS;
  }
  if (command.kind === "model") {
    return buildProviderOptions(runtime?.providers ?? [], (provider) =>
      Boolean(runtime?.models.some((model: RuntimeSnapshot["models"][number]) => model.providerId === provider.id)),
    );
  }
  if (command.kind === "login") {
    return buildProviderOptions(runtime?.providers ?? [], (provider) => provider.oauthSupported);
  }
  if (command.kind === "logout") {
    return buildProviderOptions(runtime?.providers ?? [], (provider) => provider.hasAuth);
  }

  return [];
}

function matchesCommand(command: ComposerSlashCommand, normalizedQuery: string): boolean {
  if (!normalizedQuery.startsWith("/")) {
    return false;
  }

  if (normalizedQuery === "/") {
    return true;
  }

  return [command.command, command.title, command.description].some((value) =>
    value.toLowerCase().includes(normalizedQuery),
  );
}

function describeProvider(provider: RuntimeProviderRecord): string {
  if (provider.oauthSupported) {
    return provider.hasAuth ? "OAuth connected" : "OAuth available";
  }
  if (provider.hasAuth) {
    return "Configured";
  }
  return provider.authType === "api_key" ? "Needs API key" : "Available";
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatSessionConfigStatus(config?: SessionConfig): string {
  const parts = [
    config?.provider && config?.modelId ? `Model ${config.provider}:${config.modelId}` : undefined,
    config?.thinkingLevel ? `Thinking ${config.thinkingLevel}` : undefined,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : "No session overrides set";
}

export function parseComposerCommand(value: string): ParsedComposerCommand | undefined {
  const trimmed = value.trim();
  if (trimmed === "/status") {
    return { type: "status" };
  }
  if (trimmed === "/session") {
    return { type: "session" };
  }
  if (trimmed === "/reload") {
    return { type: "reload" };
  }

  const [command, ...rest] = trimmed.split(/\s+/);
  if (command === "/compact") {
    return { type: "compact", customInstructions: rest.join(" ").trim() || undefined };
  }
  if (command === "/name") {
    const title = rest.join(" ").trim();
    return title ? { type: "name", title } : undefined;
  }
  if (command === "/thinking") {
    const thinkingLevel = rest[0]?.trim();
    if (!thinkingLevel) {
      return undefined;
    }
    return { type: "thinking", thinkingLevel };
  }

  if (command === "/model") {
    if (rest.length >= 2) {
      return {
        type: "model",
        provider: rest[0] ?? "",
        modelId: rest.slice(1).join(" "),
      };
    }

    const combined = rest[0];
    if (combined?.includes(":")) {
      const [provider, ...modelParts] = combined.split(":");
      const modelId = modelParts.join(":");
      if (provider && modelId) {
        return { type: "model", provider, modelId };
      }
    }
  }

  return undefined;
}

export function isExactSlashCommand(query: string, command: ComposerSlashCommand): boolean {
  return query.trim().toLowerCase() === command.command.toLowerCase();
}
