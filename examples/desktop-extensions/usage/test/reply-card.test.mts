import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, formatReplyCost, replyCard } from "../reply-card.ts";

const reply = (usage: Record<string, unknown>, content: unknown[], extra = {}) => ({
  role: "assistant",
  provider: "acme",
  model: "fast-1",
  content,
  usage,
  ...extra,
});
const facts = {
  isSubscription: () => false,
  modelName: () => "Fast 1",
};

await test("a reply card sums the run's model calls, tool calls, tokens and cost", () => {
  const card = replyCard({
    ...facts,
    elapsedMs: 14_230,
    context: { tokens: 82_000, contextWindow: 200_000 },
    messages: [
      { role: "user", content: [{ type: "text", text: "fix it" }] },
      reply(
        { input: 1_000, output: 300, cacheRead: 9_000, cacheWrite: 0, cost: { total: 0.012 } },
        [
          { type: "toolCall", name: "read" },
          { type: "toolCall", name: "bash" },
        ],
      ),
      { role: "toolResult", content: [] },
      reply({ input: 500, output: 800, cacheRead: 9_500, cacheWrite: 0, cost: { total: 0.009 } }, [
        { type: "text", text: "done" },
      ]),
    ],
  });
  assert.equal(card.title, "This reply");
  assert.equal(card.subtitle, "Fast 1");
  assert.equal(card.tone, "neutral");
  assert.deepEqual(card.rows, [
    { label: "Time", value: "14.2s" },
    { label: "Model calls", value: "2" },
    { label: "Tool calls", value: "2" },
    { label: "Tokens", value: "20k in · 1.1k out · 93% cached" },
    { label: "Cost", value: "$0.021" },
    { label: "Context", value: "41% · 82k of 200k" },
  ]);
});

await test("subscriptions, stopped replies and unknown context read plainly", () => {
  const card = replyCard({
    ...facts,
    isSubscription: () => true,
    elapsedMs: 125_000,
    context: { tokens: null, contextWindow: 200_000 },
    messages: [reply({ input: 10, output: 5, cost: { total: 0 } }, [], { stopReason: "aborted" })],
  });
  assert.equal(card.subtitle, "Stopped · Fast 1");
  assert.equal(card.tone, "warning");
  assert.equal(card.rows.find((row) => row.label === "Cost")?.value, "Subscription");
  assert.equal(card.rows.find((row) => row.label === "Time")?.value, "2m 05s");
  assert.equal(
    card.rows.some((row) => row.label === "Context"),
    false,
  );
  assert.equal(formatDuration(-5), "0.0s");
  assert.equal(formatReplyCost(0.0004), "<$0.001");
  assert.equal(formatReplyCost(1.5), "$1.50");
});

await test("nested model calls count and subscription replies cost nothing", () => {
  const card = replyCard({
    ...facts,
    isSubscription: (_provider, model) => model === "plan-1",
    elapsedMs: 3_000,
    context: null,
    messages: [
      reply({ input: 100, output: 10, cost: { total: 0.5 } }, [{ type: "toolCall" }], {
        model: "plan-1",
      }),
      {
        role: "toolResult",
        content: [],
        usage: { input: 1_000, output: 200, cost: { total: 0.02 } },
      },
    ],
  });
  const value = (label: string) => card.rows.find((row) => row.label === label)?.value;
  assert.equal(value("Tokens"), "1.1k in · 210 out · 0% cached");
  // The subscription reply's reported cost is left out; the nested call's cost is kept.
  assert.equal(value("Cost"), "$0.020");
  // A run a tool ends normally is not a stop.
  assert.equal(card.subtitle, "Fast 1");
  assert.equal(card.tone, "neutral");
});
