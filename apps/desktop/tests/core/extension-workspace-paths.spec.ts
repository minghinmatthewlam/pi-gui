import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForTimelineLayout,
} from "../helpers/electron-app";
import { expectExtensionViewReady } from "../helpers/desktop-extension-fixture";

async function openPathFixture(window: Page): Promise<void> {
  await window.getByTestId("workbench-add-tab").click();
  await window
    .getByTestId("workbench-chooser")
    .getByRole("button", { name: "Path fixture", exact: true })
    .click();
  await expectExtensionViewReady(window);
}

test("extension cards, views and draft attachments resolve files through a linked checkout", async () => {
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  // A local canary provider enables the composer; file actions must never invoke it.
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "path-fixture",
      defaultModel: "canary",
      enabledModels: ["path-fixture/canary"],
      packages: [],
      cacheWarming: "off",
    }),
  );
  const checkout = await makeWorkspace("extension-path-target");
  const linkedCheckout = join(userDataDir, "linked-checkout");
  await symlink(checkout, linkedCheckout, "junction");
  await mkdir(join(checkout, "src"));
  await writeFile(join(checkout, "src", "example.ts"), "// fixture\nexport const marker = 42;\n");
  await mkdir(join(userDataDir, "outside"));
  await writeFile(join(userDataDir, "outside", "secret.txt"), "OUTSIDE SENTINEL");
  await symlink(join(userDataDir, "outside"), join(checkout, "outside-link"), "junction");
  const extension = join(checkout, ".pi", "extensions", "paths");
  await mkdir(join(extension, "dist"), { recursive: true });
  await writeFile(
    join(extension, "index.ts"),
    `
import { registerDesktopView } from ${JSON.stringify(require.resolve("@pi-gui/extension-ui"))};
export default function fixture(pi) {
  pi.registerProvider("path-fixture", {
    baseUrl: "http://127.0.0.1:9/never-contact", apiKey: "LOCAL_TEST_CANARY", api: "path-fixture",
    models: [{ id: "canary", name: "Local canary", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple() { throw new Error("File actions must not send model requests"); },
  });
  registerDesktopView(pi, {
    id: "paths", title: "Path fixture", source: import.meta.url,
    frontend: new URL("./dist/desktop.js", import.meta.url),
    backend: () => ({ id: "paths.backend", setup() {} }),
  });
  pi.registerCommand("path-card", { description: "Show file action", handler: async () => {
    pi.appendEntry("pi-gui.card", { title: "File action", actions: [
      { type: "openFile", label: "Open fixture file", path: "src/example.ts", line: 2 },
    ] });
  } });
}
`,
  );
  await writeFile(
    join(extension, "dist", "desktop.js"),
    `
export function mount(root, host) {
  root.innerHTML = '<button id="open">Open view file</button><button id="outside">Open outside link</button><button id="draft">Prepare file draft</button><output role="status"></output>';
  const status = root.querySelector('output');
  root.querySelector('#open').onclick = () => host.actions.openFile({path:'src/example.ts',line:2}).catch(error => { status.textContent = error.message; });
  root.querySelector('#outside').onclick = async () => {
    try { await host.actions.openFile({path:'outside-link/secret.txt'}); status.textContent = 'Outside allowed'; }
    catch { status.textContent = 'Outside blocked'; }
  };
  root.querySelector('#draft').onclick = () => host.actions.prepareTaskDraft({
    title:'File draft', prompt:'Inspect fixture', files:[{path:'src/example.ts',line:2}],
  }).catch(error => { status.textContent = error.message; });
  return () => {};
}
`,
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [linkedCheckout],
    testMode: "background",
    scrubProviderEnv: true,
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Linked checkout");
    const state = await getDesktopState(window);
    // The app normalizes newly opened roots; the unit regression additionally
    // exercises action hosts that retain a symlink spelling.
    expect(
      state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId)?.path,
    ).toBe(await realpath(linkedCheckout));
    const composer = window.getByTestId("composer");
    await composer.fill("/path-card ");
    await composer.press("Enter");
    const card = window.getByTestId("extension-card");
    await expect(card).toContainText("File action");
    await waitForTimelineLayout(window);
    await card.getByRole("button", { name: /Open fixture file/ }).click();
    const markedLine = window.locator('[data-testid="file-line-mark"][data-line="2"]');
    await expect(markedLine).toHaveText("export const marker = 42;");

    await openPathFixture(window);
    const frame = window.frameLocator('[data-testid="extension-view-frame"]');
    await frame.getByRole("button", { name: "Open outside link", exact: true }).click();
    await expect(frame.getByRole("status")).toHaveText("Outside blocked");
    await frame.getByRole("button", { name: "Open view file", exact: true }).click();
    await expect(markedLine).toHaveText("export const marker = 42;");

    await openPathFixture(window);
    await composer.fill("Preserve the original draft");
    await frame.getByRole("button", { name: "Prepare file draft", exact: true }).click();
    await expect(window.locator(".chat-header__title")).toHaveText("File draft");
    await expect(composer).toHaveValue("Inspect fixture\n\nFiles:\n- src/example.ts:2");
    await expect(window.getByTestId("transcript")).not.toContainText("OUTSIDE SENTINEL");
  } finally {
    await harness.close();
  }
});
