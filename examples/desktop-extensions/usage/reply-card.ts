import { formatPercent, formatTokens } from "./model.ts";

/** What one reply cost, as a `pi-gui.card` record: pi-gui draws it in the thread after the reply. */
export interface ReplyCard {
  title: string;
  subtitle?: string;
  tone: "neutral" | "warning" | "error";
  rows: { label: string; value: string }[];
}

export interface ReplyFacts {
  /** The run's messages, as pi's `agent_end` event gives them. */
  messages: readonly unknown[];
  elapsedMs: number;
  /** pi's context usage after the reply, when known. */
  context: { tokens: number | null; contextWindow: number } | null;
  /** Whether a model is paid through a subscription, so it reports no per-token cost. */
  isSubscription: (provider: string, modelId: string) => boolean;
  modelName: (provider: string, modelId: string) => string | undefined;
}

export function replyCard(facts: ReplyFacts): ReplyCard {
  const replies = facts.messages.filter(isAssistant);
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let toolCalls = 0;
  // Tools that call a model themselves carry that usage on their result, as the panel counts it.
  const add = (usage: Usage | undefined, paid: boolean) => {
    input += count(usage?.input);
    output += count(usage?.output);
    cacheRead += count(usage?.cacheRead);
    cacheWrite += count(usage?.cacheWrite);
    if (paid) cost += count(usage?.cost?.total);
  };
  for (const message of facts.messages) {
    if (isAssistant(message)) {
      add(message.usage, !facts.isSubscription(message.provider, message.model));
      toolCalls += message.content.filter(
        (block) => isRecord(block) && block.type === "toolCall",
      ).length;
    } else if (isRecord(message) && message.role === "toolResult" && isRecord(message.usage)) {
      add(message.usage as Usage, true);
    }
  }
  const last = replies.at(-1);
  const subscription =
    replies.length > 0 &&
    cost === 0 &&
    replies.every((reply) => facts.isSubscription(reply.provider, reply.model));
  const prompt = input + cacheRead + cacheWrite;
  const rows = [
    { label: "Time", value: formatDuration(facts.elapsedMs) },
    { label: "Model calls", value: String(replies.length) },
    { label: "Tool calls", value: String(toolCalls) },
    {
      label: "Tokens",
      value: `${formatTokens(prompt)} in · ${formatTokens(output)} out · ${formatPercent(prompt ? cacheRead / prompt : null)} cached`,
    },
    { label: "Cost", value: subscription ? "Subscription" : formatReplyCost(cost) },
  ];
  const context = facts.context;
  if (context && context.tokens !== null && context.contextWindow > 0)
    rows.push({
      label: "Context",
      value: `${formatPercent(context.tokens / context.contextWindow)} · ${formatTokens(context.tokens)} of ${formatTokens(context.contextWindow)}`,
    });
  // A run that ends on a tool result instead of a reply was stopped while a tool ran.
  const endedOnTool =
    isRecord(facts.messages.at(-1)) &&
    (facts.messages.at(-1) as Record<string, unknown>).role === "toolResult";
  const stopped = last?.stopReason === "aborted" || endedOnTool;
  const failed = last?.stopReason === "error";
  const model = last ? (facts.modelName(last.provider, last.model) ?? last.model) : undefined;
  const subtitle = [stopped ? "Stopped" : failed ? "Failed" : "", model]
    .filter(Boolean)
    .join(" · ");
  return {
    title: "This reply",
    ...(subtitle ? { subtitle } : {}),
    tone: failed ? "error" : stopped ? "warning" : "neutral",
    rows,
  };
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

/** One reply usually costs cents, so it keeps a third decimal where the folder totals do not. */
export function formatReplyCost(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.001) return "<$0.001";
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

interface Usage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown };
}

interface AssistantReply {
  provider: string;
  model: string;
  stopReason?: unknown;
  content: unknown[];
  usage?: Usage;
}

function isAssistant(message: unknown): message is AssistantReply {
  return (
    isRecord(message) &&
    message.role === "assistant" &&
    typeof message.provider === "string" &&
    typeof message.model === "string" &&
    Array.isArray(message.content)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
