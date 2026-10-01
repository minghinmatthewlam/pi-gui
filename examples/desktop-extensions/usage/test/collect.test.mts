import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { collectUsage } from "../collect.ts";
import {
  cacheHitRate,
  formatTokens,
  periodStart,
  sumDays,
  summarize,
  totalTokens,
} from "../model.ts";
import { DEMO_THREADS, seedUsageSessions } from "./seed-sessions.ts";

const root = await mkdtemp(join(tmpdir(), "pi-usage-view-"));
const cwd = await realpath(root);
const agentDir = join(cwd, "agent");
const now = Date.now();
const seeded = await seedUsageSessions({ cwd, agentDir, now });
process.env.PI_CODING_AGENT_DIR = agentDir;

const byTitle = (title: string) => {
  const thread = seeded.find((candidate) => candidate.title === title);
  assert.ok(thread, title);
  return thread;
};

await test("reads every seeded session and matches pi's per-session usage totals", async () => {
  const usage = await collectUsage({ cwd, now });
  assert.equal(usage.threads.length, DEMO_THREADS.length);
  assert.equal(usage.unreadable, 0);
  assert.equal(usage.capped, 0);
  for (const expected of seeded) {
    const thread = usage.threads.find((candidate) => candidate.id === expected.sessionId);
    assert.ok(thread, expected.title);
    assert.equal(thread.title, expected.title);
    assert.equal(thread.model, expected.model);
    assert.equal(thread.replies, expected.replies);
    assert.equal(thread.lastActiveAt, expected.lastActiveAt);
    const counts = sumDays(thread.days, null);
    assert.deepEqual(
      { ...counts, cost: Math.round(counts.cost * 1e6) },
      { ...expected.totals, cost: Math.round(expected.totals.cost * 1e6) },
    );

    // Cross-check against pi's own session stats accounting.
    const manager = SessionManager.open(expected.path);
    let piTokens = 0;
    for (const entry of manager.getEntries()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        const { input, output, cacheRead, cacheWrite } = entry.message.usage;
        piTokens += input + output + cacheRead + cacheWrite;
      }
    }
    assert.equal(totalTokens(counts), piTokens);
  }
});

await test("period filters and the folder summary follow the seeded timestamps", async () => {
  const usage = await collectUsage({ cwd, now });
  for (const period of ["today", "7d", "30d", "all"] as const) {
    const since = periodStart(period, now);
    const summary = summarize(usage.threads, period, now);
    const expected = seeded
      .map((thread) => thread.totalsSince(since ?? -Infinity))
      .filter((counts) => totalTokens(counts) > 0);
    assert.equal(summary.rows.length, expected.length, period);
    assert.equal(
      summary.tokens,
      expected.reduce((sum, counts) => sum + totalTokens(counts), 0),
      period,
    );
  }
  const all = summarize(usage.threads, "all", now);
  assert.equal(all.rows[0]?.thread.title, "Command palettes for chats and files");
  assert.ok(Math.abs(all.rows.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9);
  assert.equal(all.subscription, false);
  const flaky = all.rows.find((row) => row.thread.title === "Root-cause the flaky tests");
  assert.ok(flaky && flaky.cacheHit !== null && flaky.cacheHit < 0.7);
  const codex = all.rows.find((row) => row.thread.title === "Ctrl-Tab thread switcher");
  assert.ok(codex?.subscription);
  assert.equal(
    summarize(usage.threads, "7d", now).rows.some(
      (row) => row.thread.title === "Draft the release notes",
    ),
    false,
  );
  assert.ok(cacheHitRate(all.totals)! > 0.8);
  assert.match(formatTokens(all.tokens), /^\d+(\.\d)?M$/);
});

await test("estimates what fills each thread's current context by kind", async () => {
  const usage = await collectUsage({ cwd, now });
  const find = (title: string) => usage.threads.find((thread) => thread.title === title)!;
  const review = find("Review the redesign PR").context;
  assert.ok(review.byKind.images > 0);
  assert.ok(review.byKind.toolResults > review.byKind.assistant);
  // Two full-diff reads (152k characters each) dominate: pi's estimate is chars / 4.
  assert.deepEqual(review.largest[0], {
    kind: "toolResults",
    label: "read",
    count: 2,
    tokens: 76_000,
  });
  assert.equal(review.largest.length, 3);
  const settings = find("Build the settings redesign").context;
  assert.ok(settings.byKind.summaries > 0);
  assert.ok(settings.byKind.thinking > 0);
  // The compaction dropped earlier turns from the current context.
  const uncompacted = find("Command palettes for chats and files").context;
  assert.ok(settings.total < uncompacted.total);
  for (const thread of usage.threads) {
    assert.equal(
      thread.context.total,
      Object.values(thread.context.byKind).reduce((sum, value) => sum + value, 0),
    );
  }
});

await test("marks the hosting thread and prefers its live entries", async () => {
  const review = byTitle("Review the redesign PR");
  const manager = SessionManager.open(review.path);
  const usage = await collectUsage({
    cwd,
    now,
    current: {
      id: review.sessionId,
      entries: manager.getEntries(),
      name: manager.getSessionName(),
      contextNow: { tokens: 120_000, contextWindow: 1_000_000 },
    },
    modelName: (provider, id) => (provider === "anthropic" ? `Claude ${id}` : undefined),
    isSubscription: (provider) => provider === "openai-codex",
  });
  const current = usage.threads.filter((thread) => thread.current);
  assert.equal(current.length, 1);
  assert.equal(current[0]?.id, review.sessionId);
  assert.deepEqual(current[0]?.contextNow, { tokens: 120_000, contextWindow: 1_000_000 });
  assert.equal(current[0]?.model, "Claude claude-opus-4-8");
  const flaky = usage.threads.find((thread) => thread.title === "Root-cause the flaky tests");
  assert.equal(flaky?.model, "gpt-5.5");
});
