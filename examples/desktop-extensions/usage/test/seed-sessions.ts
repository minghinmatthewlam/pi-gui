/**
 * Seeds realistic pi session files for one folder through pi's own SessionManager, so the
 * files are genuinely pi's format: named threads on several models, tool calls with large
 * results, attached images, a compaction summary, a subscription (zero-cost) thread and one
 * thread with a poor cache hit rate. Used by the unit test, the desktop e2e spec and demo
 * recordings. Self-contained on purpose: Playwright imports it directly.
 */

export interface SeedUsageOptions {
  /** The folder the threads belong to (the pi-gui workspace path). */
  cwd: string;
  /** pi agent directory; sessions land in its default session directory for `cwd`. */
  agentDir: string;
  /** Anchor for "last active" times. Defaults to now. */
  now?: number;
  /** Threads to write; defaults to the demo set. */
  threads?: readonly ThreadSpec[];
}

export interface SeededCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface SeededUsageThread {
  title: string;
  sessionId: string;
  path: string;
  provider: string;
  model: string;
  /** Latest message timestamp, which pi reports as the session's last activity. */
  lastActiveAt: number;
  /** Exact sums of every usage the file records, as pi's session stats total them. */
  totals: SeededCounts;
  /** Totals restricted to usage recorded at or after a given time. */
  totalsSince(since: number): SeededCounts;
  replies: number;
  subscription: boolean;
}

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ThreadSpec {
  title: string;
  /** Leave the session unnamed so the title falls back to the first user message. */
  unnamed?: boolean;
  provider: string;
  api: string;
  model: string;
  /** USD per million tokens; null for a subscription plan that reports no cost. */
  price: Price | null;
  minutesAgo: number;
  turns: number;
  /** Minutes between turns. */
  spacing: number;
  /** Tools a turn calls before replying: result size in characters, on every Nth turn. */
  tools: { name: string; resultChars: number; every?: number }[];
  /** Share of each prompt served from the provider's cache. */
  cacheHit: number;
  /** Whether the provider bills cache writes (Anthropic) or only reads (OpenAI). */
  writesCache: boolean;
  thinkingChars?: number;
  imageTurn?: number;
  compactAfterTurn?: number;
  prompts: string[];
}

const opus: Pick<ThreadSpec, "provider" | "api" | "model" | "price" | "writesCache"> = {
  provider: "anthropic",
  api: "anthropic-messages",
  model: "claude-opus-4-8",
  price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  writesCache: true,
};
const sonnet: typeof opus = {
  provider: "anthropic",
  api: "anthropic-messages",
  model: "claude-sonnet-4-6",
  price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  writesCache: true,
};
const gptApi: typeof opus = {
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.5",
  price: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  writesCache: false,
};
const codexPlan: typeof opus = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  model: "gpt-5.5",
  price: null,
  writesCache: false,
};

const HOUR = 60;
const DAY = 24 * HOUR;

export const DEMO_THREADS: readonly ThreadSpec[] = [
  {
    title: "Command palettes for chats and files",
    ...opus,
    minutesAgo: 26,
    turns: 22,
    spacing: 30,
    tools: [
      { name: "read", resultChars: 18_000, every: 2 },
      { name: "edit", resultChars: 900 },
      { name: "bash", resultChars: 6_000, every: 3 },
    ],
    cacheHit: 0.97,
    thinkingChars: 2_400,
    prompts: [
      "Add a command palette that searches chats and files together",
      "Rank recent chats above files when the query is empty",
      "Keyboard: Cmd-K opens it, arrows move, Enter opens",
    ],
  },
  {
    title: "Review the redesign PR",
    ...opus,
    minutesAgo: 5 * HOUR,
    turns: 6,
    spacing: 25,
    tools: [
      { name: "read", resultChars: 152_000, every: 3 },
      { name: "bash", resultChars: 22_000 },
    ],
    cacheHit: 0.95,
    thinkingChars: 4_000,
    imageTurn: 1,
    prompts: [
      "Review the redesign PR against main",
      "Here is the screenshot of the new sidebar, does it match the spec?",
      "Check the diff for regressions in thread switching",
    ],
  },
  {
    title: "Ctrl-Tab thread switcher",
    ...codexPlan,
    minutesAgo: 2 * DAY + 3 * HOUR,
    turns: 10,
    spacing: 30,
    tools: [
      { name: "read", resultChars: 12_000 },
      { name: "edit", resultChars: 700 },
    ],
    cacheHit: 0.96,
    prompts: [
      "Add a Ctrl-Tab switcher that cycles recent threads",
      "Show thread titles while held",
    ],
  },
  {
    title: "Build the settings redesign",
    ...opus,
    minutesAgo: 6 * DAY + 2 * HOUR,
    turns: 12,
    spacing: 45,
    tools: [
      { name: "read", resultChars: 24_000, every: 2 },
      { name: "edit", resultChars: 1_200 },
      { name: "bash", resultChars: 9_000, every: 4 },
    ],
    cacheHit: 0.98,
    thinkingChars: 3_000,
    imageTurn: 2,
    compactAfterTurn: 7,
    prompts: [
      "Rebuild settings as a single scrolling page with sections",
      "Match the attached mock for the Models section",
      "Keep keyboard focus order intact",
    ],
  },
  {
    title: "Root-cause the flaky tests",
    ...gptApi,
    minutesAgo: 3 * HOUR + 10,
    turns: 8,
    spacing: 20,
    tools: [
      { name: "bash", resultChars: 64_000 },
      { name: "grep", resultChars: 8_000, every: 2 },
    ],
    cacheHit: 0.42,
    prompts: [
      "The session list tests fail about one run in five, find out why",
      "Run the suite ten times and collect the failures",
    ],
  },
  {
    title: "Teach pi extensions in pi-gui",
    ...sonnet,
    minutesAgo: 3,
    turns: 7,
    spacing: 15,
    tools: [{ name: "read", resultChars: 30_000 }],
    cacheHit: 0.93,
    prompts: ["Explain how a pi extension adds a desktop view", "Now write a minimal example"],
  },
  {
    title: "Update pi to latest release",
    unnamed: true,
    ...sonnet,
    minutesAgo: 21,
    turns: 5,
    spacing: 10,
    tools: [{ name: "bash", resultChars: 14_000 }],
    cacheHit: 0.91,
    prompts: ["Update pi to latest release", "Fix the type errors from the upgrade"],
  },
  {
    title: "Fix sticky thread shortcut hints",
    ...codexPlan,
    minutesAgo: 9 * DAY,
    turns: 6,
    spacing: 20,
    tools: [{ name: "read", resultChars: 9_000 }],
    cacheHit: 0.97,
    prompts: ["Shortcut hints stay visible after releasing Cmd, fix it"],
  },
  {
    title: "Tidy the sidebar spacing",
    ...sonnet,
    minutesAgo: 18 * DAY,
    turns: 4,
    spacing: 15,
    tools: [{ name: "edit", resultChars: 800 }],
    cacheHit: 0.9,
    prompts: ["Tighten the sidebar row spacing to match the timeline"],
  },
  {
    title: "Draft the release notes",
    ...opus,
    minutesAgo: 40 * DAY,
    turns: 3,
    spacing: 20,
    tools: [{ name: "bash", resultChars: 5_000 }],
    cacheHit: 0.88,
    prompts: ["Draft release notes from the merged PRs since the last tag"],
  },
];

/** 1x1 PNG. pi's estimator counts any image as a fixed size, so its pixels do not matter. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const FOLLOW_UPS = [
  "Looks right. Now handle the empty state.",
  "Run the focused tests again.",
  "Can you simplify that?",
  "Check it in dark mode too.",
  "Good, keep going.",
  "What's left before this can merge?",
  "Tighten the naming and we're done.",
];

const REPLY_SENTENCES = [
  "I read the affected files first so the change stays inside the existing feature folder.",
  "The renderer already keeps this in one store, so the new behaviour reads the same selector instead of a second copy.",
  "I ran the focused tests after the edit; they pass and lint is clean.",
  "One edge case remains: an empty folder still shows the old placeholder until the list refreshes.",
  "Public types are unchanged, so no other package needs a rebuild.",
  "Keyboard and pointer follow the same path: arrows move the selection and Enter commits it.",
  "I kept the diff small and left the styling tokens alone.",
  "The next useful step is an end-to-end check on the real Electron window.",
  "Nothing here touches session files, so existing threads keep working.",
  "I removed the duplicate helper that the earlier attempt added.",
];

function prose(chars: number, seed: number): string {
  const sentences: string[] = [];
  let size = 0;
  for (let index = seed; size < chars; index += 1) {
    const sentence = REPLY_SENTENCES[index % REPLY_SENTENCES.length]!;
    sentences.push(sentence);
    size += sentence.length + 1;
  }
  return sentences.join(" ");
}

const CODE_LINES = [
  "export function PaletteRow({ item, active }: PaletteRowProps) {",
  "  const label = item.kind === 'thread' ? item.title : relativePath(item.path);",
  '  return <li aria-selected={active} className="palette-row">{label}</li>;',
  "}",
  "const results = useMemo(() => rank(query, threads, files), [query, threads, files]);",
  "  expect(await window.getByTestId('session-row').count()).toBe(3);",
  "diff --git a/apps/desktop/src/features/sidebar/sidebar.tsx b/apps/desktop/src/features/sidebar/sidebar.tsx",
  "@@ -120,7 +120,9 @@ export function Sidebar({ sessions, selected }: SidebarProps) {",
];

function filler(chars: number, seed: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let index = seed; size < chars; index += 1) {
    const line = `${CODE_LINES[index % CODE_LINES.length]} // ${index}`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n").slice(0, chars);
}

function price(counts: Omit<SeededCounts, "cost">, rate: Price | null) {
  const part = (tokens: number, perMillion: number) => (tokens * perMillion) / 1_000_000;
  const input = rate ? part(counts.input, rate.input) : 0;
  const output = rate ? part(counts.output, rate.output) : 0;
  const cacheRead = rate ? part(counts.cacheRead, rate.cacheRead) : 0;
  const cacheWrite = rate ? part(counts.cacheWrite, rate.cacheWrite) : 0;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

interface SessionManagerLike {
  appendMessage(message: Record<string, unknown>): string;
  appendCompaction(
    summary: string,
    firstKeptEntryId: string | null,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
    usage?: Record<string, unknown>,
  ): string;
  appendSessionInfo(name: string): string;
  getSessionId(): string;
  getSessionFile(): string | undefined;
}

export async function seedUsageSessions(options: SeedUsageOptions): Promise<SeededUsageThread[]> {
  const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as unknown as {
    SessionManager: { create(cwd: string): SessionManagerLike };
  };
  const now = options.now ?? Date.now();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = options.agentDir;
  try {
    return (options.threads ?? DEMO_THREADS).map((spec, index) =>
      seedThread(SessionManager.create(options.cwd), spec, index, now),
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

/** pi's system prompt and tool definitions: sent with every request, not saved in the session. */
const SYSTEM_TOKENS = 9_000;
const IMAGE_TOKENS = 1_200;
const tokensOf = (chars: number) => Math.ceil(chars / 4);

function seedThread(
  manager: SessionManagerLike,
  spec: ThreadSpec,
  index: number,
  now: number,
): SeededUsageThread {
  const records: { time: number; counts: SeededCounts }[] = [];
  let random = 17 + index * 7919;
  const next = (min: number, max: number) => {
    random = (random * 48271) % 2147483647;
    return min + (random % (max - min + 1));
  };
  const lastActiveAt = now - spec.minutesAgo * 60_000;
  let replies = 0;
  // Each request's prompt is what the session holds so far, so usage and context agree.
  const held: { id: string; tokens: number }[] = [];
  let keptFrom = 0;
  let summaryTokens = 0;
  const promptTokens = () =>
    SYSTEM_TOKENS +
    summaryTokens +
    held.slice(keptFrom).reduce((sum, item) => sum + item.tokens, 0);
  const append = (message: Record<string, unknown>, tokens: number) => {
    const id = manager.appendMessage(message);
    held.push({ id, tokens });
    return id;
  };

  const reply = (
    time: number,
    content: { chars: number; block: unknown }[],
    stopReason: "toolUse" | "stop",
  ) => {
    const prompt = promptTokens();
    const cacheRead = Math.round(prompt * spec.cacheHit);
    const cacheWrite = spec.writesCache ? Math.round((prompt - cacheRead) * 0.85) : 0;
    const counts = {
      input: prompt - cacheRead - cacheWrite,
      output: next(180, stopReason === "stop" ? 2_600 : 700),
      cacheRead,
      cacheWrite,
    };
    const cost = price(counts, spec.price);
    records.push({ time, counts: { ...counts, cost: cost.total } });
    replies += 1;
    append(
      {
        role: "assistant",
        content: content.map((part) => part.block),
        api: spec.api,
        provider: spec.provider,
        model: spec.model,
        usage: { ...counts, totalTokens: prompt + counts.output, cost },
        stopReason,
        timestamp: time,
      },
      content.reduce((sum, part) => sum + tokensOf(part.chars), 0),
    );
  };

  let firstKeptId: string | null = null;
  for (let turn = 0; turn < spec.turns; turn += 1) {
    const tools = spec.tools.filter((tool) => turn % (tool.every ?? 1) === 0);
    const turnEnd = lastActiveAt - (spec.turns - 1 - turn) * spec.spacing * 60_000;
    let time = turnEnd - (tools.length * 2 + 2) * 20_000;
    const tick = () => (time += 20_000);
    const text = spec.prompts[turn] ?? FOLLOW_UPS[(turn + index) % FOLLOW_UPS.length]!;
    const withImage = turn === spec.imageTurn;
    const userId = append(
      {
        role: "user",
        content: withImage
          ? [
              { type: "text", text },
              { type: "image", data: PNG, mimeType: "image/png" },
            ]
          : text,
        timestamp: tick(),
      },
      tokensOf(text.length) + (withImage ? IMAGE_TOKENS : 0),
    );
    if (spec.compactAfterTurn !== undefined && turn === spec.compactAfterTurn - 2)
      firstKeptId = userId;
    for (const [toolIndex, tool] of tools.entries()) {
      const callId = `call_${index}_${turn}_${toolIndex}`;
      const args =
        tool.name === "bash"
          ? { command: "pnpm exec playwright test tests/core --repeat-each 3" }
          : tool.name === "edit"
            ? {
                path: "apps/desktop/src/features/palette/palette.tsx",
                oldText: "x",
                newText: filler(600, turn),
              }
            : tool.name === "grep"
              ? { pattern: "waitForSelectedSessionReady", path: "apps/desktop/tests" }
              : { path: "apps/desktop/src/features/palette/palette.tsx" };
      const content: { chars: number; block: unknown }[] = [];
      if (spec.thinkingChars && toolIndex === 0) {
        const thinking = prose(spec.thinkingChars, turn + 3);
        content.push({
          chars: thinking.length,
          block: { type: "thinking", thinking, thinkingSignature: "" },
        });
      }
      content.push({
        chars: tool.name.length + JSON.stringify(args).length,
        block: { type: "toolCall", id: callId, name: tool.name, arguments: args },
      });
      reply(tick(), content, "toolUse");
      const output = filler(tool.resultChars, turn * 13 + toolIndex);
      append(
        {
          role: "toolResult",
          toolCallId: callId,
          toolName: tool.name,
          content: [{ type: "text", text: output }],
          isError: false,
          timestamp: tick(),
        },
        tokensOf(output.length),
      );
    }
    const answer = prose(next(160, 520), turn + index);
    reply(tick(), [{ chars: answer.length, block: { type: "text", text: answer } }], "stop");

    if (turn === spec.compactAfterTurn && firstKeptId) {
      const summary = `## Goal\nRebuild settings as one scrolling page.\n\n## Progress\n${filler(14_000, 5)}`;
      const tokensBefore = promptTokens();
      // No usage on the summary call: pi would stamp it with the seeding time, not the thread's.
      manager.appendCompaction(summary, firstKeptId, tokensBefore);
      keptFrom = held.findIndex((item) => item.id === firstKeptId);
      summaryTokens = tokensOf(summary.length);
    }
  }
  if (!spec.unnamed) manager.appendSessionInfo(spec.title);

  const sum = (since: number) => {
    const totals: SeededCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const record of records) {
      if (record.time < since) continue;
      totals.input += record.counts.input;
      totals.output += record.counts.output;
      totals.cacheRead += record.counts.cacheRead;
      totals.cacheWrite += record.counts.cacheWrite;
      totals.cost += record.counts.cost;
    }
    return totals;
  };
  return {
    title: spec.title,
    sessionId: manager.getSessionId(),
    path: manager.getSessionFile() ?? "",
    provider: spec.provider,
    model: spec.model,
    lastActiveAt,
    totals: sum(-Infinity),
    totalsSince: sum,
    replies,
    subscription: spec.price === null,
  };
}
