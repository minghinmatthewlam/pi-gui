import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";
import { expectExtensionViewReady } from "../helpers/desktop-extension-fixture";

// A view with a link button, a plain-http link main must refuse, and a box that opens a
// thread by its pi session id. Each failure shows in the view as the extension would.
async function installLinksView(workspacePath: string): Promise<void> {
  const extension = join(workspacePath, ".pi", "extensions", "links");
  await mkdir(join(extension, "dist"), { recursive: true });
  await writeFile(
    join(extension, "index.ts"),
    `import { registerDesktopView } from ${JSON.stringify(require.resolve("@pi-gui/extension-ui"))};
export default function extension(pi) {
  registerDesktopView(pi, {
    id: "links", title: "Links", source: import.meta.url,
    frontend: new URL("./dist/desktop.js", import.meta.url),
    backend: () => ({ id: "links.backend", setup() {} }),
  });
  pi.registerCommand("jump", {
    description: "Card that opens a thread",
    handler: async (args) => pi.appendEntry("pi-gui.card", {
      title: "Related thread",
      actions: [{ type: "openThread", label: "Open related thread", sessionId: args.trim() }],
    }),
  });
}`,
  );
  await writeFile(
    join(extension, "dist", "desktop.js"),
    `export function mount(root, host) {
  const error = document.createElement("p");
  error.setAttribute("role", "status");
  const run = (promise) => {
    error.textContent = "";
    promise.catch((reason) => { error.textContent = reason.message; });
  };
  const button = (label, onClick) => {
    const element = document.createElement("button");
    element.textContent = label;
    element.onclick = onClick;
    root.append(element);
  };
  const thread = document.createElement("input");
  thread.setAttribute("aria-label", "Thread id");
  button("Open pull request", () => run(host.actions.openUrl("https://github.com/minghinmatthewlam/pi-gui/pull/220")));
  button("Open plain link", () => run(host.actions.openUrl("http://example.com")));
  root.append(thread);
  button("Open thread", () =>
    run(host.actions.openThread(thread.value).then(() => console.log("view saw thread open"))),
  );
  root.append(error);
  return () => {};
}`,
  );
}

test("an extension view opens https links and threads beside its own", async () => {
  test.setTimeout(90_000);
  const workspacePath = await makeWorkspace("extension-view-links");
  const otherFolder = await makeWorkspace("extension-view-links-other");
  await installLinksView(workspacePath);
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [otherFolder, workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await harness.electronApp.evaluate(({ shell }) => {
      const globals = globalThis as typeof globalThis & { __openedLinks?: string[] };
      globals.__openedLinks = [];
      shell.openExternal = async (url: string) => {
        globals.__openedLinks?.push(url);
      };
    });
    const openedLinks = () =>
      harness.electronApp.evaluate(
        () => (globalThis as typeof globalThis & { __openedLinks?: string[] }).__openedLinks ?? [],
      );

    // A thread in another folder, then two in the view's folder.
    await createNamedThread(window, "Other folder thread", {
      workspaceName: "extension-view-links-other",
    });
    const otherFolderThread = (await getDesktopState(window)).selectedSessionId!;
    await createNamedThread(window, "Earlier thread", { workspaceName: "extension-view-links" });
    const earlierThread = (await getDesktopState(window)).selectedSessionId!;
    await createNamedThread(window, "Current thread", { workspaceName: "extension-view-links" });
    const currentThread = (await getDesktopState(window)).selectedSessionId!;

    if (!(await window.getByTestId("workbench").isVisible()))
      await window.getByTestId("toggle-side-panel").click();
    await window.getByTestId("workbench-add-tab").click();
    await window
      .getByTestId("workbench-chooser")
      .getByRole("button", { name: "Links", exact: true })
      .click();
    await expectExtensionViewReady(window);
    const frame = window.frameLocator('[data-testid="extension-view-frame"]');
    const status = frame.getByRole("status");

    await frame.getByRole("button", { name: "Open pull request" }).click();
    await expect
      .poll(openedLinks)
      .toEqual(["https://github.com/minghinmatthewlam/pi-gui/pull/220"]);
    await frame.getByRole("button", { name: "Open plain link" }).click();
    await expect(status).toHaveText("Extensions can only open https links");
    expect(await openedLinks()).toHaveLength(1);

    // Only threads in the view's own folder open; the app stays where it was otherwise.
    await frame.getByLabel("Thread id").fill(otherFolderThread);
    await frame.getByRole("button", { name: "Open thread" }).click();
    await expect(status).toHaveText("That thread isn't open in this folder");
    await expect(window.locator(".chat-header__title")).toHaveText("Current thread");

    await frame.getByLabel("Thread id").fill(earlierThread);
    const viewLogs: string[] = [];
    window.on("console", (message) => viewLogs.push(message.text()));
    await frame.getByRole("button", { name: "Open thread" }).click();
    await expect(window.locator(".chat-header__title")).toHaveText("Earlier thread");
    // The view's call succeeds even though switching threads then closes the view.
    await expect.poll(() => viewLogs).toContain("view saw thread open");
    expect((await getDesktopState(window)).selectedSessionId).toBe(earlierThread);

    // A card button opens a thread through the same check.
    const composer = window.getByTestId("composer");
    await composer.fill(`/jump ${currentThread}`);
    await composer.press("Enter");
    const card = window.getByTestId("extension-card");
    await expect(card.getByRole("button", { name: /Open related thread/ })).toContainText(
      "Opens thread",
    );
    await card.getByRole("button", { name: /Open related thread/ }).click();
    await expect(window.locator(".chat-header__title")).toHaveText("Current thread");
  } finally {
    await harness.close();
  }
});
