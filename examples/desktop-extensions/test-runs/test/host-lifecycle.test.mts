import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createFacetHost, type FacetHost } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  DESKTOP_VIEW_REGISTER,
  type DesktopViewDeclaration,
  type DesktopViewRegistrationEvent,
} from "@pi-gui/extension-ui";
import { ENTRY_TYPE, TestRuns, type RunRecord } from "../contract.ts";

await test(
  "disposing the actual file extension's backend host stops its process without Pi shutdown",
  { timeout: 15_000 },
  async () => {
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-test-runs-host-"));
    const bus = createEventBus();
    const declarations: DesktopViewDeclaration[] = [];
    bus.on(DESKTOP_VIEW_REGISTER, (event) => {
      const registration = event as DesktopViewRegistrationEvent;
      declarations.push(registration.declaration);
      registration.accept?.();
    });
    const settingsManager = SettingsManager.inMemory({});
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      eventBus: bus,
      additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    const manager = SessionManager.inMemory(cwd);
    const previousTestContext = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    // The slow file runs in a grandchild that this process cannot wait for, and
    // its reaping belongs to init. Its probe connection closes when it exits.
    const probe = createServer();
    const probePath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\${agentDir.split(/[\\/]/).at(-1)}`
        : join(agentDir, "exit.sock");
    probe.listen(probePath);
    await once(probe, "listening");
    const probeConnection = once(probe, "connection") as Promise<[Socket]>;
    process.env.PI_TEST_RUNS_EXIT_PROBE = probePath;
    let session: AgentSession | undefined;
    let host: FacetHost | undefined;
    try {
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      assert.equal(declarations.length, 1);
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        model: modelRuntime.getModels()[0],
        sessionManager: manager,
        settingsManager,
        resourceLoader: loader,
      }));
      await session.bindExtensions({});
      host = await createFacetHost({ facets: [declarations[0]!.backend()] });
      const service = host.services.use(TestRuns);
      const { runId } = await service.start(
        { suiteId: "slow", requestId: "host-disposal" },
        BACKGROUND_CONTEXT,
      );
      const deadline = Date.now() + 5_000;
      let pid: number | undefined;
      while (!pid) {
        const run = service.state.value?.runs.find((candidate) => candidate.id === runId);
        const match = run?.output.match(/Slow test PID: (\d+)/);
        if (match?.[1]) pid = Number(match[1]);
        else {
          if (Date.now() > deadline)
            throw new Error("The real slow process did not report its PID.");
          await setTimeout(20);
        }
      }
      assert.equal(
        service.state.value?.runs.find((run) => run.id === runId)?.outcome.kind,
        "running",
      );
      process.kill(pid, 0);
      const [slowProcess] = await probeConnection;
      const slowProcessExited = new Promise((resolve) => slowProcess.once("close", resolve));
      await host.dispose();
      const records = manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE);
      assert.equal(records.length, 2);
      const last = records.at(-1);
      assert.ok(last?.type === "custom");
      const finished = last.data as { run: RunRecord };
      assert.equal(finished.run.id, runId);
      assert.equal(finished.run.outcome.kind, "cancelled");
      assert.ok(finished.run.endedAt);
      // Disposal SIGKILLs the whole process group. Unkilled, this file sleeps 8 s.
      assert.ok(
        await Promise.race([
          slowProcessExited.then(() => true),
          setTimeout(5_000, false, { ref: false }),
        ]),
        "The slow test process kept running after host disposal.",
      );
      // The terminal fallback can still run later; repeated teardown adds no result.
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await host.dispose();
      assert.equal(
        manager
          .getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE).length,
        2,
      );
    } finally {
      await host?.dispose();
      session?.dispose();
      loader.getExtensions().runtime.invalidate();
      bus.clear();
      probe.close();
      delete process.env.PI_TEST_RUNS_EXIT_PROBE;
      if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = previousTestContext;
    }
  },
);
