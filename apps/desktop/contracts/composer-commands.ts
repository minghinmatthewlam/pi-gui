import type { SessionConfig } from "@pi-gui/session-driver";
import type { RuntimeCommandRecord, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";

export type ParsedComposerCommand =
  | { type: "model"; provider: string; modelId: string }
  | { type: "thinking"; thinkingLevel: string }
  | { type: "tree" }
  | { type: "status" }
  | { type: "session" }
  | { type: "reload" }
  | { type: "compact"; customInstructions?: string }
  | { type: "name"; title: string };

const INCOMPLETE_COMMAND_MESSAGES: Readonly<Record<string, string>> = {
  "/compact": "Add optional instructions after /compact or send it directly from the slash menu.",
  "/login": "Choose a provider from the slash menu before sending /login.",
  "/logout": "Choose a connected provider from the slash menu before sending /logout.",
  "/model": "Choose a provider and model from the slash menu before sending /model.",
  "/name": "Add a thread title after /name.",
  "/scoped-models": "Open Enabled models from the slash menu or Settings.",
  "/settings": "Open Settings from the slash menu or Cmd+,.",
  "/thinking": "Choose a reasoning level from the slash menu before sending /thinking.",
} as const;

export function resolveRuntimeCommands(
  runtime: RuntimeSnapshot | undefined,
  sessionCommands: readonly RuntimeCommandRecord[],
): readonly RuntimeCommandRecord[] {
  if (!runtime) {
    return sessionCommands;
  }

  const baseCommands = runtime.settings.enableSkillCommands
    ? sessionCommands
    : sessionCommands.filter((command) => command.source !== "skill");
  if (!runtime.settings.enableSkillCommands) {
    return baseCommands;
  }

  const merged = [...baseCommands];
  const seenNames = new Set(baseCommands.map((command) => command.name));
  for (const skill of runtime.skills) {
    if (!skill.enabled) {
      continue;
    }

    const commandName = normalizeRuntimeCommandName(skill.slashCommand);
    if (seenNames.has(commandName)) {
      continue;
    }

    seenNames.add(commandName);
    merged.push({
      name: commandName,
      description: skill.description,
      source: "skill",
      sourceInfo: {
        path: skill.filePath,
        source: skill.source,
        scope: skill.filePath.startsWith(runtime.workspace.path) ? "project" : "user",
        origin: "top-level",
        baseDir: skill.baseDir,
      },
    });
  }

  return merged;
}

export function hasRuntimeSlashCommand(
  text: string,
  runtime: RuntimeSnapshot | undefined,
  sessionCommands: readonly RuntimeCommandRecord[],
): boolean {
  return Boolean(resolveRuntimeSlashCommand(text, runtime, sessionCommands));
}

export function resolveRuntimeSlashCommand(
  text: string,
  runtime: RuntimeSnapshot | undefined,
  sessionCommands: readonly RuntimeCommandRecord[],
): RuntimeCommandRecord | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const spaceIndex = trimmed.indexOf(" ");
  const commandName = normalizeRuntimeCommandName(
    spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex),
  );
  return resolveRuntimeCommands(runtime, sessionCommands).find(
    (command) => command.name === commandName,
  );
}

function normalizeRuntimeCommandName(value: string): string {
  return value.trim().replace(/^\/+/, "");
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
  if (trimmed === "/tree") {
    return { type: "tree" };
  }
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

export function incompleteComposerCommandMessage(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const [command] = trimmed.split(/\s+/);
  return INCOMPLETE_COMMAND_MESSAGES[command as keyof typeof INCOMPLETE_COMMAND_MESSAGES];
}
