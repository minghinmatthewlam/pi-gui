import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import { desktopIpc } from "../../contracts/ipc";
import {
  createNamedThread,
  emitTestSessionEvent,
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
    await harness.ipc.control(desktopIpc.persistComposerDraft, { mode: "hold" });
    const sends = await harness.driver.intercept("sendUserMessage");
    const cancels = await harness.driver.intercept("cancelCurrentRun");
    const emit = (ref: SessionRef, status: "running" | "idle") =>
      emitTestSessionEvent(harness, {
        type: "sessionUpdated",
        sessionRef: ref,
        timestamp: new Date().toISOString(),
        snapshot: {
          ref,
          workspace: { workspaceId: ref.workspaceId, path: workspacePath },
          title: "Original running task",
          status,
          updatedAt: new Date().toISOString(),
        },
      });

    const composer = window.getByTestId("composer");
    await composer.fill("Keep this run active until Stop");
    await window.getByTestId("send").click();
    const send = await sends.nextCall();
    await emit(send.args[0] as SessionRef, "running");
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
    const cancel = await cancels.nextCall();
    expect(cancel.args[0], "Stop targeted the wrong task").toEqual(target);
    await emit(target, "idle");
    await cancel.complete();
    await send.complete();
    await expect(originalRow).not.toHaveAttribute("data-sidebar-indicator", "running");
    await expect(composer).toHaveValue("Keep my unsent original draft");
    await expect(window.locator(".chat-header__title")).toHaveText("Original running task");
    await harness.ipc.release(desktopIpc.persistComposerDraft);
    await expect(window.locator(".chat-header__title")).toHaveText("Extension prepared task");
    await expect(composer).toHaveValue("Inspect the extension findings.");
    await selectSession(window, "Original running task");
    await expect(composer).toHaveValue("Keep my unsent original draft");
  } finally {
    await harness.ipc.release(desktopIpc.persistComposerDraft).catch(() => {});
    await harness.close();
  }
});
