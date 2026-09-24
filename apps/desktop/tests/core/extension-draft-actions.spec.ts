import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import { desktopIpc } from "../../contracts/ipc";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
} from "../helpers/electron-app";
import { expectExtensionViewReady } from "../helpers/desktop-extension-fixture";

test("Stop remains available while an extension saves the running task's protected draft", async () => {
  const workspacePath = await makeWorkspace("extension-draft-stop");
  const extension = join(workspacePath, ".pi", "extensions", "draft-actions");
  await mkdir(join(extension, "dist"), { recursive: true });
  await writeFile(
    join(extension, "index.ts"),
    `import { registerDesktopView } from ${JSON.stringify(require.resolve("@pi-gui/extension-ui"))};
export default function extension(pi) {
  registerDesktopView(pi, {
    id: "draft-actions", title: "Draft actions", source: import.meta.url,
    frontend: new URL("./dist/desktop.js", import.meta.url),
    backend: () => ({ id: "draft-actions.backend", setup() {} }),
  });
}`,
  );
  await writeFile(
    join(extension, "dist", "desktop.js"),
    `export function mount(root, host) {
  const button = document.createElement("button");
  button.textContent = "Prepare task draft";
  button.onclick = () => host.actions.prepareTaskDraft({
    title: "Extension prepared task", prompt: "Inspect the extension findings."
  }).catch(error => { root.dataset.error = error.message; });
  root.append(button);
  return () => {};
}`,
  );
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Original running task");
    if (!(await window.getByTestId("workbench").isVisible()))
      await window.getByTestId("toggle-side-panel").click();
    await window.getByTestId("workbench-add-tab").click();
    const choice = window
      .getByTestId("workbench-chooser")
      .getByRole("button", { name: "Draft actions", exact: true });
    // The chooser and tab show the view's title, never the internal extension hash.
    await expect(choice).toHaveText("Draft actions");
    await choice.click();
    const frame = window.frameLocator('[data-testid="extension-view-frame"]');
    await expect(
      frame.getByRole("button", { name: "Prepare task draft", exact: true }),
    ).toBeVisible();
    await expectExtensionViewReady(window);
    await expect(window.getByRole("tab", { name: "Draft actions", exact: true })).toHaveAttribute(
      "title",
      /^Draft actions \(/,
    );
    const state = await getDesktopState(window);
    const target = { workspaceId: state.selectedWorkspaceId!, sessionId: state.selectedSessionId! };

    // Hold a real submit open and delay only the draft-persistence boundary. Visible Prepare
    // and Stop still traverse the renderer, preload, host ownership and cancellation paths.
    await harness.electronApp.evaluate(
      async ({ ipcMain }, input) => {
        type InvokeHandler = (...args: unknown[]) => unknown;
        const handlers = (
          ipcMain as typeof ipcMain & { readonly _invokeHandlers?: Map<string, InvokeHandler> }
        )._invokeHandlers;
        const persist = handlers?.get(input.persistChannel);
        if (!handlers || !persist) throw new Error("Missing draft persistence handler");
        let releaseDraft = () => {};
        const draftGate = new Promise<void>((resolveDraft) => {
          releaseDraft = resolveDraft;
        });
        handlers.set(input.persistChannel, async (...args) => {
          await draftGate;
          return persist(...args);
        });
        const { createRequire } = process.getBuiltinModule("module");
        const load = createRequire(input.entry);
        const { PiSdkDriver: Driver } = load("@pi-gui/pi-sdk-driver") as {
          PiSdkDriver: typeof PiSdkDriver;
        };
        const hooks = (
          globalThis as {
            __PI_APP_TEST_HOOKS?: { emitSessionEvent(event: SessionDriverEvent): Promise<void> };
          }
        ).__PI_APP_TEST_HOOKS;
        if (!hooks) throw new Error("Test event hook unavailable");
        let releaseRun = () => {};
        const emit = (ref: SessionRef, status: "running" | "idle") =>
          hooks.emitSessionEvent({
            type: "sessionUpdated",
            sessionRef: ref,
            timestamp: new Date().toISOString(),
            snapshot: {
              ref,
              workspace: { workspaceId: ref.workspaceId, path: input.workspacePath },
              title: "Original running task",
              status,
              updatedAt: new Date().toISOString(),
            },
          });
        Driver.prototype.sendUserMessage = async function (ref) {
          const runGate = new Promise<void>((resolveRun) => {
            releaseRun = resolveRun;
          });
          await emit(ref, "running");
          await runGate;
        };
        Driver.prototype.cancelCurrentRun = async function (ref) {
          if (
            ref.workspaceId !== input.target.workspaceId ||
            ref.sessionId !== input.target.sessionId
          )
            throw new Error("Stop targeted the wrong task");
          await emit(ref, "idle");
          releaseRun();
        };
        (
          globalThis as {
            __extensionDraftStopControl?: { releaseDraft(): void; releaseAll(): void };
          }
        ).__extensionDraftStopControl = {
          releaseDraft,
          releaseAll() {
            releaseDraft();
            releaseRun();
          },
        };
      },
      {
        entry: resolve("apps/desktop/out/main/main.js"),
        workspacePath,
        target,
        persistChannel: desktopIpc.persistComposerDraft,
      },
    );

    const composer = window.getByTestId("composer");
    await composer.fill("Keep this run active until Stop");
    await window.getByTestId("send").click();
    const originalRow = window.locator(`.session-row[data-session-id="${target.sessionId}"]`);
    await expect(originalRow).toHaveAttribute("data-sidebar-indicator", "running");
    await composer.fill("Keep my unsent original draft");
    await frame.getByRole("button", { name: "Prepare task draft", exact: true }).click();
    await expect(window.getByTestId("composer-prepare-task-status")).toBeVisible();
    expect(await composer.evaluate((element) => element.closest("[inert]") !== null)).toBe(true);
    const stop = window.getByRole("button", { name: "Stop run", exact: true });
    await expect(stop).toBeEnabled();
    expect(await stop.evaluate((element) => element.closest("[inert]") === null)).toBe(true);
    await stop.click();
    await expect(originalRow).not.toHaveAttribute("data-sidebar-indicator", "running");
    await expect(composer).toHaveValue("Keep my unsent original draft");
    await expect(window.locator(".chat-header__title")).toHaveText("Original running task");
    await harness.electronApp.evaluate(() => {
      const control = (globalThis as { __extensionDraftStopControl?: { releaseDraft(): void } })
        .__extensionDraftStopControl;
      if (!control) throw new Error("Missing draft gate");
      control.releaseDraft();
    });
    await expect(window.locator(".chat-header__title")).toHaveText("Extension prepared task");
    await expect(composer).toHaveValue("Inspect the extension findings.");
    await selectSession(window, "Original running task");
    await expect(composer).toHaveValue("Keep my unsent original draft");
  } finally {
    await harness.electronApp
      .evaluate(() => {
        (
          globalThis as { __extensionDraftStopControl?: { releaseAll(): void } }
        ).__extensionDraftStopControl?.releaseAll();
      })
      .catch(() => {});
    await harness.close();
  }
});
