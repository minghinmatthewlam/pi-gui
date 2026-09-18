import { join } from "node:path";
import {
  SessionManager,
  SettingsManager,
  createExtensionRuntime,
  createAgentSession,
  ModelRuntime,
  type CreateAgentSessionOptions,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { SessionModelSelection, WorkspaceRef } from "@pi-gui/session-driver";
import { messageText as sessionMessageText } from "./session-supervisor-utils.js";

export interface GenerateThreadTitleOptions {
  readonly prompt: string;
  readonly model?: SessionModelSelection;
  readonly thinkingLevel?: string;
  readonly signal?: AbortSignal;
}

interface ThreadTitleGeneratorDeps {
  readonly agentDir: string;
}

const MAX_THREAD_TITLE_LENGTH = 36;
const THREAD_TITLE_SYSTEM_PROMPT = [
  "You generate concise UI thread titles for a coding assistant.",
  "Return only the title text.",
  "Keep it short, usually 2 to 5 words.",
  "Use the same language as the source message.",
  "Preserve ticket IDs exactly.",
  "No markdown, quotes, labels, or trailing punctuation.",
].join("\n");

export async function generateThreadTitle(
  workspace: WorkspaceRef,
  options: GenerateThreadTitleOptions,
  deps: ThreadTitleGeneratorDeps,
): Promise<string | null> {
  const prompt = options.prompt.trim();
  if (!prompt || options.signal?.aborted) {
    return null;
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = createThreadTitleResourceLoader();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(deps.agentDir, "auth.json"),
    modelsPath: join(deps.agentDir, "models.json"),
    refreshOnCreate: false,
  });
  await modelRuntime.refresh({ allowNetwork: false });

  const createOptions: CreateAgentSessionOptions = {
    cwd: workspace.path,
    agentDir: deps.agentDir,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
    tools: [],
  };
  if (options.model) {
    const selectedModel = modelRuntime.getModel(options.model.provider, options.model.modelId);
    if (!selectedModel) {
      return null;
    }
    createOptions.model = selectedModel;
  }
  if (options.thinkingLevel) {
    createOptions.thinkingLevel = options.thinkingLevel as NonNullable<
      CreateAgentSessionOptions["thinkingLevel"]
    >;
  }

  const { session } = await createAgentSession(createOptions);
  const handleAbort = () => {
    void session.abort().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", handleAbort, { once: true });
  try {
    if (options.signal?.aborted) {
      return null;
    }
    if (!session.model) {
      return null;
    }
    const auth = await session.modelRuntime.getAuth(session.model.provider);
    if (!auth?.auth.apiKey) {
      return null;
    }

    await session.prompt(buildTitlePrompt(prompt), { source: "interactive" });
    return normalizeThreadTitle(extractLastAssistantText(session));
  } finally {
    options.signal?.removeEventListener("abort", handleAbort);
    session.dispose();
  }
}

function createThreadTitleResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => THREAD_TITLE_SYSTEM_PROMPT,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function buildTitlePrompt(prompt: string): string {
  return [
    "Generate a short UI thread title for the user's first message.",
    "Return only the title.",
    "",
    "<user_message>",
    prompt,
    "</user_message>",
  ].join("\n");
}

function extractLastAssistantText(session: { messages: readonly unknown[] }): string {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }
    return sessionMessageText(message);
  }
  return "";
}

function normalizeThreadTitle(title: string): string | null {
  let normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  normalized = normalized.replace(/^title\s*:\s*/i, "").trim();
  normalized = stripWrappingQuotes(normalized);
  normalized = normalized.replace(/[.?!,:;]+$/g, "").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length > MAX_THREAD_TITLE_LENGTH) {
    normalized = `${normalized.slice(0, MAX_THREAD_TITLE_LENGTH - 3).trimEnd()}...`;
  }

  return normalized || null;
}

function stripWrappingQuotes(value: string): string {
  let current = value.trim();
  while (current.length >= 2) {
    const first = current[0];
    const last = current[current.length - 1];
    if (
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === "`" && last === "`")
    ) {
      current = current.slice(1, -1).trim();
      continue;
    }
    break;
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
