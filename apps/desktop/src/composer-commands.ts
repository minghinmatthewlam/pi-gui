import type { SessionConfig } from "@pi-app/session-driver";

export interface ComposerSlashCommand {
  readonly command: string;
  readonly template: string;
  readonly title: string;
  readonly description: string;
}

export type ParsedComposerCommand =
  | { type: "model"; provider: string; modelId: string }
  | { type: "thinking"; thinkingLevel: string }
  | { type: "status" };

export const SLASH_COMMANDS: readonly ComposerSlashCommand[] = [
  {
    command: "/model",
    template: "/model openai gpt-5.4",
    title: "Model",
    description: "Set provider and model for this session",
  },
  {
    command: "/thinking",
    template: "/thinking high",
    title: "Reasoning",
    description: "Set thinking level for this session",
  },
  {
    command: "/status",
    template: "/status",
    title: "Status",
    description: "Show current session overrides in the timeline",
  },
];

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

  const [command, ...rest] = trimmed.split(/\s+/);
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
