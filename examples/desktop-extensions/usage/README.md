# Usage

A file-based Pi extension that shows what your threads cost two ways: a card in
the thread after each reply, and a side-panel view that totals token usage across
every saved thread of the current folder and estimates what fills each thread's
context. It reads Pi's own session data; nothing is sent anywhere.

- **After each reply**: on `agent_start` it notes the time; on `agent_end` it sums
  the run's assistant messages and writes a `pi-gui.card` entry with the reply's
  time, model calls, tool calls, tokens (in, out, % cached), cost (or
  **Subscription**) and context used (`ctx.getContextUsage()`). pi-gui draws the
  card below the reply; terminal Pi ignores it, and it never enters the model's
  context. The card appears when the reply finishes rather than updating live,
  because a card that updates stays where it first appeared.

- **Usage**: `SessionManager.list(cwd)` finds the folder's sessions (newest 200;
  older ones are counted, not read). Each file is summed the way Pi's
  `getSessionStats()` sums it (the numbers pi-gui's usage footer shows): assistant,
  tool-result, usage-entry and compaction/branch-summary usage, all branches. Usage
  is bucketed by local day so the view can filter Today / 7 days / 30 days / All
  time. Cache hit is `cacheRead / (input + cacheRead + cacheWrite)`. Replies from a
  subscription provider (OAuth with a subscription plan, or Kimi Coding, as pi-gui's
  footer decides) count tokens but no cost; a period whose replies all cost zero
  shows **Subscription**.
- **What fills context (estimated)**: Pi's `buildSessionProjection` gives each
  thread's current, compaction-aware branch context; Pi's `estimateTokens`
  (chars / 4, fixed size per image) measures each block, grouped as tool results,
  tool calls, your messages, agent replies, thinking, images, summaries and
  extension messages. Only kinds, tool names, counts and sizes reach the browser,
  never message text. The system prompt and tool definitions are not included.
- **This thread**: the hosting thread uses its live entries and, when a model is
  selected, Pi's `ctx.getContextUsage()` for context used against the window.

The view recomputes when opened, on **Refresh**, after each agent run in this
thread (`agent_end`), and updates just this thread after each turn (`turn_end`).
Terminal Pi gets `/usage`, a short text summary.

A thread row expands in place; **Open thread** switches pi-gui to that thread
(`host.actions.openThread`), which closes the view.

```sh
node examples/desktop-extensions/usage/build.mjs
node --experimental-strip-types --test examples/desktop-extensions/usage/test/*.test.mts
node node_modules/typescript/bin/tsc -p examples/desktop-extensions/usage/tsconfig.json
```

`test/seed-sessions.ts` exports `seedUsageSessions({ cwd, agentDir, now?, threads? })`,
which writes realistic sessions through Pi's `SessionManager` (several models, large
tool results, images, a compaction, a subscription thread, a poor cache hit) and
returns each thread's exact totals. The desktop spec
`apps/desktop/tests/core/extension-usage-view.spec.ts` uses it.
