import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  installDesktopExtensionFixture as installFixture,
  openDesktopExtensionFixture as openFixture,
} from "../helpers/desktop-extension-fixture";
import {
  createNamedThread,
  selectSession,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("custom frontend exchanges Chord state while its opaque frame cannot access preload, parent, network or navigation", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.end("Unexpected extension navigation");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture HTTP address");
  const workspace = await makeWorkspace("desktop-security");
  await installFixture(workspace, `http://127.0.0.1:${address.port}/forbidden`);
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Custom view boundary");
    await openFixture(window);
    const frameElement = window.getByTestId("extension-view-frame");
    const frame = window.frameLocator('[data-testid="extension-view-frame"]');
    await expect(frame.getByRole("heading", { name: "Security fixture" })).toBeVisible();
    await expect(frame.locator("#counter")).toHaveText("Count 0 · activations 1");
    await expect(frameElement).toHaveAttribute("sandbox", "allow-scripts");
    await expect(frame.locator("#boundary")).toHaveText(
      JSON.stringify({
        preload: "undefined",
        process: "undefined",
        require: "undefined",
        parentAccess: "blocked",
        origin: "null",
      }),
    );
    await frame.getByRole("button", { name: "Increment", exact: true }).click();
    await expect(frame.locator("#counter")).toHaveText("Count 1 · activations 1");
    await frame.getByRole("button", { name: "Try network", exact: true }).click();
    await expect(frame.locator("#network-result")).toHaveText("Network blocked");
    await frame.getByRole("button", { name: "Try navigation", exact: true }).click();
    await expect(frame.locator("#navigation-result")).toHaveText("Navigation blocked");
    expect(requests).toEqual([]);
    await frame.getByRole("button", { name: "Try outside file", exact: true }).click();
    await expect(frame.locator("#outside-result")).toHaveText("Outside blocked");
    const screenshot = test.info().outputPath("opaque-frame-and-live-state.png");
    await window.screenshot({ path: screenshot, animations: "disabled" });
    await test
      .info()
      .attach("Opaque frame with live Chord state", { path: screenshot, contentType: "image/png" });

    await window.getByRole("button", { name: "Reload view", exact: true }).click();
    await expect(frame.locator("#counter")).toHaveText("Count 1 · activations 1");
    const oldFrameUrl = await frameElement.getAttribute("src");
    expect(oldFrameUrl).toBeTruthy();
    await window.getByTestId("composer").fill("/reload ");
    await window.getByTestId("composer").press("Enter");
    await expect(frame.locator("#counter")).toHaveText("Count 0 · activations 1");
    expect(await frameElement.getAttribute("src")).not.toBe(oldFrameUrl);
    // This is a boundary assertion against the real exposed API, not a shortcut for UI behavior.
    const staleResult = await window.evaluate(async (connectionId) => {
      try {
        await globalThis.window.piApp.sendExtensionViewMessage({
          connectionId,
          message: { type: "closed", reason: "old runtime" },
        });
        return "allowed";
      } catch {
        return "rejected";
      }
    }, new URL(oldFrameUrl!).hostname);
    expect(staleResult).toBe("rejected");

    // No debounce wait: navigation from the iframe must persist the latest visible draft first.
    await window.getByTestId("composer").fill("Unsent original task draft");
    await frame.getByRole("button", { name: "Prepare task draft", exact: true }).click();
    await expect(window.locator(".chat-header__title")).toHaveText("Extension prepared task");
    await expect(window.getByTestId("composer")).toHaveValue(
      "Inspect the scoped extension findings.",
    );
    await selectSession(window, "Custom view boundary");
    await expect(window.getByTestId("composer")).toHaveValue("Unsent original task draft");
  } finally {
    await harness.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("a failed author mount keeps conversation editable and Reload view recovers the same backend", async () => {
  const workspace = await makeWorkspace("desktop-mount-failure");
  await installFixture(workspace, "http://127.0.0.1:9/unused");
  const frontend = join(workspace, ".pi", "extensions", "desktop-security", "dist", "desktop.js");
  await writeFile(frontend, "export function mount() { throw new Error('Fixture mount failed'); }");
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Conversation survives broken view");
    await openFixture(window);
    await expect(window.getByTestId("extension-view-panel")).toContainText("Fixture mount failed");
    await window.getByTestId("composer").fill("Draft while custom view is broken");
    await expect(window.getByTestId("composer")).toHaveValue("Draft while custom view is broken");
    await installFixture(workspace, "http://127.0.0.1:9/unused");
    await window.getByRole("button", { name: "Reload view", exact: true }).click();
    const frame = window.frameLocator('[data-testid="extension-view-frame"]');
    await expect(frame.locator("#counter")).toHaveText("Count 0 · activations 1");
    await expect(window.getByTestId("composer")).toHaveValue("Draft while custom view is broken");
    await frame.getByRole("button", { name: "Increment", exact: true }).click();
    await expect(frame.locator("#counter")).toHaveText("Count 1 · activations 1");
  } finally {
    await harness.close();
  }
});

test("two real windows share one task backend while their frame connections remain isolated", async () => {
  const workspace = await makeWorkspace("desktop-two-windows");
  await installFixture(workspace, "http://127.0.0.1:9/unused");
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const first = await harness.firstWindow();
    await createNamedThread(first, "Shared extension task");
    await openFixture(first);
    const firstFrame = first.frameLocator('[data-testid="extension-view-frame"]');
    await expect(firstFrame.locator("#counter")).toHaveText("Count 0 · activations 1");
    const firstUrl = await first.getByTestId("extension-view-frame").getAttribute("src");
    if (!firstUrl) throw new Error("Missing first frame URL");
    const existing = new Set(harness.electronApp.windows());
    // The native New Window shortcut is owned by before-input-event, as in multi-window.spec.
    await harness.electronApp.evaluate(
      ({ BrowserWindow }, modifier) => {
        BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
          type: "keyDown",
          keyCode: "n",
          modifiers: [modifier],
        });
      },
      process.platform === "darwin" ? "meta" : "control",
    );
    await expect.poll(() => harness.electronApp.windows().length).toBe(2);
    const second = harness.electronApp.windows().find((candidate) => !existing.has(candidate));
    if (!second) throw new Error("Expected second desktop window");
    await second.waitForLoadState("domcontentloaded");
    await selectSession(second, "Shared extension task");
    await openFixture(second);
    const secondFrame = second.frameLocator('[data-testid="extension-view-frame"]');
    await expect(secondFrame.locator("#counter")).toHaveText("Count 0 · activations 1");
    expect(await second.getByTestId("extension-view-frame").getAttribute("src")).not.toBe(firstUrl);
    const wrongSender = await second.evaluate(async (connectionId) => {
      try {
        await globalThis.window.piApp.sendExtensionViewMessage({
          connectionId,
          message: { type: "closed", reason: "wrong window" },
        });
        return "allowed";
      } catch {
        return "rejected";
      }
    }, new URL(firstUrl).hostname);
    expect(wrongSender).toBe("rejected");
    await firstFrame.getByRole("button", { name: "Increment", exact: true }).click();
    await expect(firstFrame.locator("#counter")).toHaveText("Count 1 · activations 1");
    await expect(secondFrame.locator("#counter")).toHaveText("Count 1 · activations 1");
    await first.close();
    await expect.poll(() => harness.electronApp.windows().length).toBe(1);
    await secondFrame.getByRole("button", { name: "Increment", exact: true }).click();
    await expect(secondFrame.locator("#counter")).toHaveText("Count 2 · activations 1");
    const closedSender = await second.evaluate(async (connectionId) => {
      try {
        await globalThis.window.piApp.sendExtensionViewMessage({
          connectionId,
          message: { type: "closed", reason: "closed window" },
        });
        return "allowed";
      } catch {
        return "rejected";
      }
    }, new URL(firstUrl).hostname);
    expect(closedSender).toBe("rejected");
    const screenshot = test.info().outputPath("surviving-window-shared-backend.png");
    await second.screenshot({ path: screenshot, animations: "disabled" });
    await test.info().attach("Shared backend after another window closes", {
      path: screenshot,
      contentType: "image/png",
    });
  } finally {
    await harness.close();
  }
});
