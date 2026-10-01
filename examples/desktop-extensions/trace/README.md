# Trace

A file-based Pi extension that traces each reply as it happens: a side-panel
waterfall of the model calls and tool calls pi makes, on one time axis, with the
context each model call sent. It only listens to pi's events; it adds no tools,
changes nothing the model sees, and writes nothing to the session.

- **Spans** come from pi's extension events:
  - **Reply**: the first `agent_start` to `agent_settled`. One reply can be several
    passes of pi's loop (a retry, overflow recovery, queued messages, an extension
    asking to continue); each pass has its own `agent_start`/`agent_end`, so the
    recorder numbers turns itself.
  - **Turn**: `turn_start` to the next `turn_start` or the end of the pass. The
    example has no `turn_end` handler on purpose: having one makes pi build the
    session context for it on every turn.
  - **Model call**: the `context` event (fires once per model call, for every
    provider, as the request is built) to the assistant `message_end`. The assistant
    `message_start` marks the first response, so the bar shows waiting (light) and
    streaming (solid). A call that fails before the provider answers has no first
    response, and one that fails while pi prepares the request still shows with its
    error. The model name and window come from the model that answered.
- Views get at most one update every 50 ms, and finished replies are copied once,
  so recording stays cheap inside pi's awaited event handlers.
  - **Tool**: `tool_execution_start` to `tool_execution_end`, matched by
    `toolCallId` (parallel calls end in any order) and nested under
    `parentToolCallId` when a tool calls another tool.
  - **Compaction**: `session_before_compact` to `session_compact` or
    `session_compact_failed`. Inside a reply it sits under it; one outside a reply
    (`/compact`, or pi compacting before a new prompt) is its own entry.
  - Anything still open when the reply settles or the session shuts down closes as
    stopped.
- **Context sent** is `input + cacheRead + cacheWrite` from the call's usage, against
  that call's model window. Stopped or failed calls that report no tokens show "—".
- The trace keeps the last 20 replies of this thread since it opened, up to 400
  spans each, with argument and result previews capped at 1,000 and 2,000
  characters. It starts empty when the thread changes.

The view picks a reply (it follows the newest one), shows its time, model calls,
tool calls and peak context, and a waterfall that grows live. Click a row for its
details: timing, first response, context and tokens for a model call;
arguments and result for a tool. Terminal Pi gets `/trace`, a text outline of the
latest reply.

```sh
node examples/desktop-extensions/trace/build.mjs
node --experimental-strip-types --test examples/desktop-extensions/trace/test/*.test.mts
node node_modules/typescript/bin/tsc -p examples/desktop-extensions/trace/tsconfig.json
```

The desktop spec `apps/desktop/tests/core/extension-trace-view.spec.ts` drives a
scripted model through pi's real loop and real `read` tool and checks the live and
finished waterfall.
