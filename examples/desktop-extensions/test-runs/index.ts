import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  createLocalBashOperations,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerDesktopView } from "@pi-gui/extension-ui";
import { isActive, outcomeLabel, TestRuns, type Suite } from "./contract.ts";
import { TestRunOwner } from "./run-owner.ts";

// The browser can select only these suites. It never supplies shell text or paths.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const fixtureCommand = (name: string) =>
  `node --test --test-reporter=tap ${shellQuote(fileURLToPath(new URL(`./fixtures/${name}.test.mjs`, import.meta.url)))}`;

export const suites: Suite[] = [
  {
    id: "passing",
    label: "Passing fixture",
    command: fixtureCommand("passing"),
    timeoutSeconds: 10,
  },
  {
    id: "failing",
    label: "Failing fixture",
    command: fixtureCommand("failing"),
    timeoutSeconds: 10,
  },
  {
    id: "slow",
    label: "Slow fixture · try Stop",
    command: fixtureCommand("slow"),
    timeoutSeconds: 20,
  },
  { id: "timeout", label: "Timeout fixture", command: fixtureCommand("slow"), timeoutSeconds: 1 },
];

export default function testRunsExtension(pi: ExtensionAPI): void {
  let context: ExtensionContext | null = null;
  const owner = new TestRunOwner(suites, createLocalBashOperations(), (type, data) => {
    pi.appendEntry(type, data);
  });
  const restore = (_event: unknown, ctx: ExtensionContext) => {
    context = ctx;
    owner.restore(ctx.cwd, ctx.sessionManager.getBranch());
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_before_tree", async () => {
    await owner.stopActive();
  });
  pi.on("session_shutdown", async () => {
    await owner.suspend();
    context = null;
  });

  pi.registerCommand("tests", {
    description: "Run an example test suite: /tests passing|failing|slow|timeout|stop",
    async handler(args, ctx) {
      const suiteId = args.trim() || "passing";
      if (suiteId === "stop") {
        const running = owner.snapshot().runs.find(isActive);
        if (running) await owner.cancel({ runId: running.id });
        ctx.ui.notify(running ? "Test run stopped." : "No test run is active.", "info");
        return;
      }
      try {
        if (!ctx.isIdle())
          throw new Error("Finish the current Pi operation before starting tests.");
        const { runId } = owner.start({ suiteId, requestId: randomUUID() });
        const run = await owner.wait(runId);
        ctx.ui.notify(`${run.label}: ${outcomeLabel(run)}\n${run.output}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "run_tests",
    label: "Test Runs",
    description:
      "Run one configured example suite and return its actual command outcome and output. Suite IDs: passing, failing, slow, timeout. These are demonstration fixtures, not repository checks.",
    parameters: Type.Object({ suiteId: Type.String() }),
    async execute(toolCallId, params, signal, onUpdate) {
      const requestId = `tool_${createHash("sha256").update(toolCallId).digest("hex")}`;
      const { runId } = owner.start({ suiteId: params.suiteId, requestId }, signal);
      const unsubscribe = owner.subscribe((state) => {
        const run = state.runs.find((candidate) => candidate.id === runId);
        if (run) {
          onUpdate?.({
            content: [{ type: "text", text: `${outcomeLabel(run)}\n${run.output}` }],
            details: run,
          });
        }
      });
      try {
        const run = await owner.wait(runId);
        return {
          content: [
            {
              type: "text",
              text: `${run.command}\n${outcomeLabel(run)}\n${run.output}${run.truncated ? `\n[Output truncated; ${run.outputBytes} bytes received.]` : ""}`,
            },
          ],
          details: run,
        };
      } finally {
        unsubscribe();
      }
    },
  });

  registerDesktopView(pi, {
    id: "test-runs",
    title: "Test Runs",
    source: import.meta.url,
    frontend: new URL("./dist/desktop.js", import.meta.url),
    backend: () =>
      defineFacet({
        id: "pi-gui.example.test-runs.backend",
        setup(env) {
          const state = env.replicatedState(owner.snapshot());
          env.own(owner.subscribe((next) => state.replace(BACKGROUND_CONTEXT, next)));
          // The backend host outlives tabs, but must stop processes when the
          // extension is removed or the desktop quits without Pi shutdown.
          env.own(() => owner.suspend());
          env.provide(TestRuns, {
            state,
            async start(request, context) {
              context.abortSignal?.throwIfAborted();
              // The accepted run belongs to the Pi session, not this browser call.
              return startFromDesktop(request);
            },
            async cancel(request, context) {
              context.abortSignal?.throwIfAborted();
              await owner.cancel(request);
            },
          });
        },
      }),
  });

  function startFromDesktop(request: { suiteId: string; requestId: string }) {
    // Pi's idle predicate includes tree summarization. A cancelled tree change
    // emits no completion event; checking it here avoids a stuck local busy flag.
    if (!context?.isIdle())
      throw new Error("Finish the current Pi operation before starting tests.");
    return owner.start(request);
  }
}
