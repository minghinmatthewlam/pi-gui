import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord";
import type { DesktopViewDeclaration } from "@pi-gui/extension-ui";
import { expect, test } from "@playwright/test";
import { createJiti } from "jiti";

// The desktop Playwright harness uses CommonJS; Chord's public entry is ESM-only.
const jiti = createJiti(__filename);
let defineFacet: typeof import("@earendil-works/chord").defineFacet;
let defineService: typeof import("@earendil-works/chord").defineService;
let DesktopExtensionViewOwner: typeof import("../../electron/extensions/extension-view-owner").DesktopExtensionViewOwner;
test.beforeAll(async () => {
  ({ defineFacet, defineService } =
    await jiti.import<typeof import("@earendil-works/chord")>("@earendil-works/chord"));
  ({ DesktopExtensionViewOwner } = await jiti.import<
    typeof import("../../electron/extensions/extension-view-owner")
  >("../../electron/extensions/extension-view-owner.ts"));
});

const target = { workspaceId: "workspace-a", sessionId: "session-a" };

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-view-owner-"));
  const directory = await realpath(temporary);
  const source = path.join(directory, "index.ts");
  const frontend = path.join(directory, "dist", "desktop.js");
  await mkdir(path.dirname(frontend));
  await writeFile(source, "export default () => {};");
  await writeFile(frontend, "export function mount() { return () => {}; }");
  let activations = 0;
  let disposals = 0;
  const Counter = defineService<{ increment(context: Context): Promise<{ value: number }> }>(
    "fixture.counter",
  );
  const declaration: DesktopViewDeclaration = {
    id: "counter",
    title: "Counter",
    source: pathToFileURL(source).href,
    frontend: pathToFileURL(frontend),
    backend: () =>
      defineFacet({
        id: "fixture.backend",
        setup(env) {
          let value = 0;
          env.provide(Counter, {
            async increment() {
              return { value: ++value };
            },
          });
          env.onActivate(() => {
            activations += 1;
          });
          env.own(() => {
            disposals += 1;
          });
        },
      }),
  };
  return {
    directory,
    source,
    declaration,
    activations: () => activations,
    disposals: () => disposals,
  };
}

test("desktop view connections keep one backend and enforce their original window and generation", async () => {
  const data = await fixture();
  const actions: unknown[] = [];
  const owner = new DesktopExtensionViewOwner({
    frameDocument: ({ frontendUrl }) => `<script type="module" src="${frontendUrl}"></script>`,
    onHostAction: async (context) => {
      actions.push(context);
    },
  });
  try {
    const runtime = {
      target,
      generation: "one",
      extensions: [{ resolvedPath: data.source }],
      declarations: [data.declaration],
    };
    await owner.replaceRuntime(runtime);
    await owner.replaceRuntime(runtime);
    expect(data.activations()).toBe(1);
    const view = owner.listViews(target)[0]!;
    const firstMessages: unknown[] = [];
    const secondMessages: unknown[] = [];
    const first = await owner.openConnection(
      { target, extensionId: view.extensionId, viewId: view.id, senderId: 1 },
      (message) => firstMessages.push(message),
    );
    const second = await owner.openConnection(
      { target, extensionId: view.extensionId, viewId: view.id, senderId: 2 },
      (message) => secondMessages.push(message),
    );
    const request = {
      type: "request",
      requestId: "one",
      call: { serviceId: "fixture.counter", member: "increment", args: [] },
    };
    await expect(owner.receive(first.connectionId, 2, request)).rejects.toThrow("another window");
    await owner.receive(first.connectionId, 1, request);
    expect(firstMessages).toContainEqual({
      type: "result",
      requestId: "one",
      ok: true,
      value: { value: 1 },
    });
    owner.closeConnection(first.connectionId, 1);
    expect(data.disposals()).toBe(0);
    await owner.receive(second.connectionId, 2, { ...request, requestId: "two" });
    expect(secondMessages).toContainEqual({
      type: "result",
      requestId: "two",
      ok: true,
      value: { value: 2 },
    });
    await owner.invokeHostAction(second.connectionId, 2, {
      type: "openFile",
      path: "src/example.ts",
    });
    expect(actions).toEqual([
      expect.objectContaining({
        target,
        senderId: 2,
        generation: "one",
        connectionId: second.connectionId,
      }),
    ]);
    await owner.invalidateRuntime(target, "one");
    expect(data.disposals()).toBe(1);
    expect(owner.listViews(target)).toEqual([]);
    await expect(owner.receive(second.connectionId, 2, request)).rejects.toThrow("unavailable");
    expect((await owner.assetResponse(second.frameUrl)).status).toBe(404);
  } finally {
    await owner.dispose();
    await rm(data.directory, { recursive: true, force: true });
  }
});

test("desktop asset routes require a live capability and apply the opaque-frame policy", async () => {
  const data = await fixture();
  const owner = new DesktopExtensionViewOwner({
    frameDocument: () => "<main id='root'></main>",
    hostAssets: { "frame-bridge.js": { body: "export {};", contentType: "text/javascript" } },
    onHostAction: async () => {},
  });
  try {
    await owner.replaceRuntime({
      target,
      generation: "one",
      extensions: [{ resolvedPath: data.source }],
      declarations: [data.declaration],
    });
    const view = owner.listViews(target)[0]!;
    const connection = await owner.openConnection(
      { target, extensionId: view.extensionId, viewId: view.id, senderId: 1 },
      () => {},
    );
    const frame = await owner.assetResponse(connection.frameUrl);
    expect(frame.status).toBe(200);
    expect(frame.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
    expect(frame.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
    expect(frame.headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
    const module = await owner.assetResponse(`${connection.frameUrl}assets/desktop.js`);
    expect(module.status).toBe(200);
    expect(module.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await owner.assetResponse(`${connection.frameUrl}_host/frame-bridge.js`)).status).toBe(
      200,
    );
    expect(
      (await owner.assetResponse(`${connection.frameUrl}assets/%2e%2e%2findex.ts`)).status,
    ).toBe(404);
    expect((await owner.assetResponse(`${connection.frameUrl}assets/missing.js`)).status).toBe(404);
    owner.closeSender(1);
    expect((await owner.assetResponse(`${connection.frameUrl}assets/desktop.js`)).status).toBe(404);
  } finally {
    await owner.dispose();
    await rm(data.directory, { recursive: true, force: true });
  }
});

test("same view IDs from different extensions are isolated and old invalidation cannot close a new runtime", async () => {
  const first = await fixture();
  const second = await fixture();
  const owner = new DesktopExtensionViewOwner({
    frameDocument: () => "",
    onHostAction: async () => {},
  });
  try {
    const input = {
      target,
      generation: "one",
      extensions: [{ resolvedPath: first.source }, { resolvedPath: second.source }],
      declarations: [first.declaration, second.declaration],
    };
    await owner.replaceRuntime(input);
    expect(owner.listViews(target)).toHaveLength(2);
    expect(new Set(owner.listViews(target).map((view) => view.extensionId)).size).toBe(2);
    await owner.replaceRuntime({ ...input, generation: "two" });
    await owner.invalidateRuntime(target, "one");
    expect(owner.listViews(target).every((view) => view.generation === "two")).toBe(true);
    expect(first.activations()).toBe(2);
    expect(first.disposals()).toBe(1);
  } finally {
    await owner.dispose();
    await rm(first.directory, { recursive: true, force: true });
    await rm(second.directory, { recursive: true, force: true });
  }
});

test("one failed disposer cannot retain another removed view or its connections", async () => {
  const first = await fixture();
  const second = await fixture();
  const diagnostics: string[] = [];
  const failing: DesktopViewDeclaration = {
    ...first.declaration,
    id: "failing",
    backend: () =>
      defineFacet({
        id: "failing-disposer",
        setup(env) {
          env.own(() => {
            throw new Error("fixture disposal failed");
          });
        },
      }),
  };
  const owner = new DesktopExtensionViewOwner({
    frameDocument: () => "",
    onHostAction: async () => {},
    onDiagnostic: (_target, _source, message) => diagnostics.push(message),
  });
  try {
    const runtime = {
      target,
      generation: "one",
      extensions: [{ resolvedPath: first.source }, { resolvedPath: second.source }],
      declarations: [failing, second.declaration],
    };
    await owner.replaceRuntime(runtime);
    const survivor = owner.listViews(target).find(({ id }) => id === "counter")!;
    const connection = await owner.openConnection(
      { target, extensionId: survivor.extensionId, viewId: survivor.id, senderId: 1 },
      () => {},
    );
    await owner.replaceRuntime({ ...runtime, declarations: [] });
    expect(owner.listViews(target)).toEqual([]);
    expect(() => owner.getConnectionContext(connection.connectionId, 1)).toThrow("unavailable");
    expect(second.disposals()).toBe(1);
    await expect.poll(() => diagnostics).toContain("fixture disposal failed");
  } finally {
    await owner.dispose();
    await rm(first.directory, { recursive: true, force: true });
    await rm(second.directory, { recursive: true, force: true });
  }
});

test("a stalled activation reports a view error and disposes its late host", async () => {
  const data = await fixture();
  let release!: () => void;
  const activation = new Promise<void>((resolve) => {
    release = resolve;
  });
  let disposed = false;
  const declaration: DesktopViewDeclaration = {
    ...data.declaration,
    backend: () =>
      defineFacet({
        id: "stalled-backend",
        setup(env) {
          env.onActivate(() => activation);
          env.own(() => {
            disposed = true;
          });
        },
      }),
  };
  const owner = new DesktopExtensionViewOwner({
    frameDocument: () => "",
    onHostAction: async () => {},
    activationTimeoutMs: 20,
  });
  try {
    await owner.replaceRuntime({
      target,
      generation: "one",
      extensions: [{ resolvedPath: data.source }],
      declarations: [declaration],
    });
    expect(owner.listViews(target)).toEqual([
      expect.objectContaining({
        state: "error",
        error: expect.stringContaining("activation timed out"),
      }),
    ]);
    await owner.invalidateRuntime(target, "one");
    release();
    await expect.poll(() => disposed).toBe(true);
  } finally {
    release();
    await owner.dispose();
    await rm(data.directory, { recursive: true, force: true });
  }
});

test("a loaded extension with a missing browser build appears as an actionable view error", async () => {
  const data = await fixture();
  const owner = new DesktopExtensionViewOwner({
    frameDocument: () => "",
    onHostAction: async () => {},
  });
  try {
    const missing = {
      ...data.declaration,
      frontend: pathToFileURL(path.join(data.directory, "dist", "missing.js")),
    };
    const runtime = {
      target,
      generation: "one",
      extensions: [{ resolvedPath: data.source }],
      declarations: [missing],
    };
    await owner.replaceRuntime(runtime);
    expect(owner.listViews(target)).toEqual([
      expect.objectContaining({
        id: "counter",
        state: "error",
        error: expect.stringContaining("missing.js"),
      }),
    ]);
    expect(data.activations()).toBe(0);
    await owner.replaceRuntime({ ...runtime, declarations: [data.declaration] });
    expect(owner.listViews(target)).toEqual([expect.objectContaining({ state: "ready" })]);
    expect(data.activations()).toBe(1);
  } finally {
    await owner.dispose();
    await rm(data.directory, { recursive: true, force: true });
  }
});

test("a replacement declaration can reuse the ID of a removed pending activation", async () => {
  test.setTimeout(5_000);
  const data = await fixture();
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const activationStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let oldDisposed = false;
  const oldDeclaration: DesktopViewDeclaration = {
    ...data.declaration,
    backend: () =>
      defineFacet({
        id: "pending-replaced-backend",
        setup(env) {
          env.onActivate(() => {
            started();
            return pending;
          });
          env.own(() => {
            oldDisposed = true;
          });
        },
      }),
  };
  const diagnostics: string[] = [];
  const owner = new DesktopExtensionViewOwner({
    frameDocument: () => "",
    onHostAction: async () => {},
    onDiagnostic: (_target, _source, message) => diagnostics.push(message),
    activationTimeoutMs: 1_000,
  });
  const runtime = {
    target,
    generation: "same-runtime",
    extensions: [{ resolvedPath: data.source }],
    declarations: [oldDeclaration],
  };
  const initial = owner.replaceRuntime(runtime);
  try {
    await activationStarted;
    // Public dispose/register replaces the declaration without replacing Pi's runtime.
    await owner.replaceRuntime({ ...runtime, declarations: [] });
    await owner.replaceRuntime({ ...runtime, declarations: [data.declaration] });
    expect(owner.listViews(target)).toEqual([
      expect.objectContaining({ id: "counter", state: "ready", generation: "same-runtime" }),
    ]);
    expect(data.activations()).toBe(1);
    expect(oldDisposed).toBe(false);
    release();
    await initial;
    expect(oldDisposed).toBe(true);
    expect(owner.listViews(target)).toEqual([
      expect.objectContaining({ id: "counter", state: "ready", generation: "same-runtime" }),
    ]);
    expect(diagnostics).not.toContain("Duplicate desktop view ID in one extension");
  } finally {
    release();
    await initial;
    await owner.dispose();
    await rm(data.directory, { recursive: true, force: true });
  }
});
