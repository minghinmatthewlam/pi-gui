import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  installDesktopExtensionFixture,
  expectExtensionViewReady,
  openDesktopExtensionFixture,
} from "../helpers/desktop-extension-fixture";
import {
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
  startThreadFromSurface,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("packaged extension frame loads its bundled bridge and exchanges live Chord state", async () => {
  test.setTimeout(120_000);
  const workspace = await makeWorkspace("packaged-extension-view");
  const harness = await launchPackagedDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const artifact = await harness.electronApp.evaluate(({ app }) => ({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      defaultApp: Boolean(process.defaultApp),
    }));
    expect(artifact.isPackaged).toBe(true);
    expect(artifact.defaultApp).toBe(false);
    expect(artifact.appPath).toMatch(/[/\\]app\.asar$/);

    // Use the shipped author helper too: a checkout import would conceal omissions from ASAR.
    // Runtime discovery happens when the first task starts, after this fixture is installed.
    await installDesktopExtensionFixture(
      workspace,
      "http://127.0.0.1:9/unused",
      join(artifact.appPath, "node_modules", "@pi-gui", "extension-ui", "dist", "index.js"),
    );
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspace);
    await startThreadFromSurface(window, { prompt: "Packaged extension view" });

    const bridgeResponse = window.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.protocol === "pi-extension:" && url.pathname === "/_host/frame-bridge.js";
    });
    await openDesktopExtensionFixture(window);
    expect((await bridgeResponse).status()).toBe(200);
    const frameElement = window.getByTestId("extension-view-frame");
    const frame = window.frameLocator('[data-testid="extension-view-frame"]');
    await expect(frameElement).toHaveAttribute("sandbox", "allow-scripts");
    await expect(frame.getByRole("heading", { name: "Security fixture" })).toBeVisible();
    await expect(frame.locator("#counter")).toHaveText("Count 0 · activations 1");
    await expectExtensionViewReady(window);
    await frame.getByRole("button", { name: "Increment", exact: true }).click();
    await expect(frame.locator("#counter")).toHaveText("Count 1 · activations 1");

    // A fresh connection must hydrate the same live backend state from the packaged bridge.
    const firstFrameUrl = await frameElement.getAttribute("src");
    if (!firstFrameUrl) throw new Error("Missing packaged extension frame URL");
    await window.getByRole("button", { name: "Reload view", exact: true }).click();
    await expect(frameElement).not.toHaveAttribute("src", firstFrameUrl);
    await expect(frameElement).toHaveAttribute("src", /^pi-extension:\/\/[^/]+\/$/);
    await expect(frame.locator("#counter")).toHaveText("Count 1 · activations 1");
    const screenshot = test.info().outputPath("packaged-extension-chord-state.png");
    await window.screenshot({ path: screenshot, animations: "disabled" });
    await test.info().attach("Packaged extension Chord state", {
      path: screenshot,
      contentType: "image/png",
    });
  } finally {
    await harness.close();
  }
});
