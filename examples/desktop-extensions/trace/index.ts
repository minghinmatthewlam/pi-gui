import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDesktopView } from "@pi-gui/extension-ui";
import { Trace, type TraceState } from "./contract.ts";
import { outline } from "./format.ts";
import { TraceRecorder, type TraceEvent } from "./trace.ts";

const PUBLISH_MS = 50;

export default function traceExtension(pi: ExtensionAPI): void {
  let recorder = new TraceRecorder();
  const listeners = new Set<(next: TraceState) => void>();
  let pending: ReturnType<typeof setTimeout> | null = null;

  const publish = () => {
    pending = null;
    if (listeners.size === 0) return;
    const state = recorder.snapshot();
    for (const listener of listeners) listener(state);
  };
  // pi awaits event handlers, so recording stays cheap and views get at most one update per
  // PUBLISH_MS: the trace should not slow down the loop it measures.
  const record = (event: TraceEvent) => {
    recorder.record(event, Date.now());
    if (listeners.size > 0) pending ??= setTimeout(publish, PUBLISH_MS);
  };

  // A new, resumed or forked thread starts an empty trace; nothing is written to the session.
  pi.on("session_start", () => {
    recorder = new TraceRecorder();
    if (pending) clearTimeout(pending);
    publish();
  });
  pi.on("agent_start", () => record({ type: "agent_start" }));
  pi.on("turn_start", () => record({ type: "turn_start" }));
  // Fires once per model call, for every provider, as the request is built.
  pi.on("context", (_event, ctx) => {
    record({
      type: "context",
      model: {
        name: ctx.model?.name ?? "Model",
        contextWindow: ctx.model?.contextWindow ?? null,
      },
    });
  });
  pi.on("message_start", (event) => record({ type: "message_start", message: event.message }));
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    // Name the model that answered: a routed model can differ from the one selected.
    const model =
      message.role === "assistant"
        ? ctx.modelRegistry.find(message.provider, message.model)
        : undefined;
    record({
      type: "message_end",
      message,
      ...(model ? { model: { name: model.name, contextWindow: model.contextWindow } } : {}),
    });
  });
  pi.on("tool_execution_start", (event) =>
    record({
      type: "tool_execution_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
    }),
  );
  pi.on("tool_execution_end", (event) =>
    record({
      type: "tool_execution_end",
      toolCallId: event.toolCallId,
      result: event.result,
      isError: event.isError,
    }),
  );
  pi.on("agent_end", () => record({ type: "agent_end" }));
  pi.on("agent_settled", () => record({ type: "agent_settled" }));
  pi.on("session_before_compact", (event) =>
    record({ type: "session_before_compact", reason: event.reason }),
  );
  pi.on("session_compact", () => record({ type: "session_compact" }));
  pi.on("session_compact_failed", (event) =>
    record({
      type: "session_compact_failed",
      aborted: event.aborted,
      ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
    }),
  );
  pi.on("session_shutdown", () => record({ type: "session_shutdown" }));

  pi.registerCommand("trace", {
    description: "Outline the latest reply (or compaction) with its model calls, tools and timing",
    handler(_args, ctx) {
      const run = recorder.latest();
      ctx.ui.notify(
        run ? outline(run, Date.now()) : "No replies traced in this thread yet.",
        "info",
      );
      return Promise.resolve();
    },
  });

  registerDesktopView(pi, {
    id: "trace",
    title: "Trace",
    source: import.meta.url,
    frontend: new URL("./dist/desktop.js", import.meta.url),
    backend: () =>
      defineFacet({
        id: "pi-gui.example.trace.backend",
        setup(env) {
          const replicated = env.replicatedState(recorder.snapshot());
          const listener = (next: TraceState) => replicated.replace(BACKGROUND_CONTEXT, next);
          listeners.add(listener);
          env.own(() => {
            listeners.delete(listener);
            if (listeners.size === 0 && pending) {
              clearTimeout(pending);
              pending = null;
            }
          });
          env.provide(Trace, { state: replicated });
        },
      }),
  });
}
