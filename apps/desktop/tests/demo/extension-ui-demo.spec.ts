import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  writeProjectExtension,
} from "../helpers/electron-app";
import { join } from "node:path";

// Demo: one slash command per ctx.ui capability so a viewer can see how pi-gui renders each.
const extensionSource = String.raw`
export default function uiDemo(pi) {
  const cmd = (name, description, handler) => pi.registerCommand(name, { description, handler });

  cmd("demo-notify", "ctx.ui.notify at three levels", async (_a, ctx) => {
    ctx.ui.notify("notify(): info level", "info");
    ctx.ui.notify("notify(): warning level", "warning");
    ctx.ui.notify("notify(): error level", "error");
  });
  cmd("demo-status", "ctx.ui.setStatus with two keys", async (_a, ctx) => {
    ctx.ui.setStatus("build", "Build: passing");
    ctx.ui.setStatus("branch", "Branch: feature/demo");
  });
  cmd("demo-widget", "ctx.ui.setWidget above and below the editor", async (_a, ctx) => {
    ctx.ui.setWidget("todo", ["TODO widget (aboveEditor)", "  [ ] write tests", "  [x] read docs"]);
    ctx.ui.setWidget("hint", ["Hint widget (belowEditor): press / for commands"], { placement: "belowEditor" });
  });
  cmd("demo-title", "ctx.ui.setTitle", async (_a, ctx) => {
    ctx.ui.setTitle("Title set by extension");
  });
  cmd("demo-select", "ctx.ui.select dialog", async (_a, ctx) => {
    const choice = await ctx.ui.select("select(): pick a runner", ["vitest", "node:test", "jest"]);
    ctx.ui.notify("select() returned: " + String(choice), "info");
  });
  cmd("demo-confirm", "ctx.ui.confirm dialog", async (_a, ctx) => {
    const ok = await ctx.ui.confirm("confirm(): delete the cache?", "This cannot be undone.");
    ctx.ui.notify("confirm() returned: " + String(ok), "info");
  });
  cmd("demo-input", "ctx.ui.input dialog", async (_a, ctx) => {
    const value = await ctx.ui.input("input(): name for the branch", "feature/...");
    ctx.ui.notify("input() returned: " + String(value), "info");
  });
  cmd("demo-editor", "ctx.ui.editor dialog", async (_a, ctx) => {
    const text = await ctx.ui.editor("editor(): edit the PR description", "## Summary\n\n- ");
    ctx.ui.notify("editor() returned " + String(text ? text.length : 0) + " chars", "info");
  });
  cmd("demo-editor-text", "ctx.ui.setEditorText writes into the composer", async (_a, ctx) => {
    ctx.ui.setEditorText("Draft written by setEditorText(): please review src/app.ts");
  });
  cmd("demo-custom", "ctx.ui.custom (terminal-only component)", async (_a, ctx) => {
    await ctx.ui.custom(() => ({ render: () => ["a TUI component"] }));
    ctx.ui.notify("custom() succeeded (should not happen in pi-gui)", "info");
  });
  cmd("demo-message", "pi.sendMessage custom message (display: true)", async () => {
    pi.sendMessage({ customType: "demo-note", content: "custom message from sendMessage(): goes to the model AND the transcript", display: true, details: { level: "info" } });
  });
  cmd("demo-entry", "pi.appendEntry custom entry (never sent to the model)", async (_a, ctx) => {
    pi.appendEntry("demo-card", { message: "appendEntry(): durable data, not in model context" });
    ctx.ui.notify("appendEntry() wrote a demo-card entry to the session file", "info");
  });
  cmd("demo-clear", "clear status, widgets and title", async (_a, ctx) => {
    ctx.ui.setStatus("build", ""); ctx.ui.setStatus("branch", "");
    ctx.ui.setWidget("todo", []); ctx.ui.setWidget("hint", [], { placement: "belowEditor" });
    ctx.ui.setTitle("");
  });
}
`;

async function caption(page: Page, step: string, text: string) {
  await page.evaluate(
    ({ step, text }) => {
      let el = document.getElementById("demo-caption");
      if (!el) {
        el = document.createElement("div");
        el.id = "demo-caption";
        Object.assign(el.style, {
          position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)",
          zIndex: "99999", background: "#111827", color: "#f9fafb", padding: "10px 18px",
          borderRadius: "10px", font: "600 18px system-ui, sans-serif", boxShadow: "0 4px 16px rgba(0,0,0,.35)",
          pointerEvents: "none", maxWidth: "80vw",
        });
        document.body.appendChild(el);
      }
      el.textContent = `${step}  ·  ${text}`;
    },
    { step, text },
  );
}

async function runCommand(page: Page, command: string) {
  const composer = page.getByTestId("composer");
  await composer.click();
  await composer.fill(command + " ");
  await page.waitForTimeout(900);
  await composer.press("Enter");
}

test("records how pi-gui renders each ctx.ui call", async () => {
  test.setTimeout(240_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  const workspacePath = await makeWorkspace("ui-demo-workspace");
  await writeProjectExtension(workspacePath, "ui-demo.ts", extensionSource);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    envOverrides: { PI_APP_TEST_MODE: undefined },
  });
  try {
    await harness.focusWindow();
    const page = await harness.firstWindow();
    await page.waitForTimeout(1500);
    await createNamedThread(page, "Extension UI demo");
    await page.waitForTimeout(1500);
    const pause = (ms = 2500) => page.waitForTimeout(ms);

    await caption(page, "1/12", "notify(): three levels → transcript activity rows");
    await runCommand(page, "/demo-notify");
    await pause(3000);

    await caption(page, "2/12", "setStatus(): two keys → the extension dock above the composer");
    await runCommand(page, "/demo-status");
    await pause();
    await page.getByTestId("extension-dock-toggle").click();
    await pause();

    await caption(page, "3/12", "setWidget(): aboveEditor and belowEditor → same dock");
    await runCommand(page, "/demo-widget");
    await pause(3000);

    await caption(page, "4/12", "setTitle() → thread header title");
    await runCommand(page, "/demo-title");
    await pause();

    await caption(page, "5/12", "select() → modal; choose node:test");
    await runCommand(page, "/demo-select");
    const dialog = page.getByTestId("extension-dialog");
    await expect(dialog).toBeVisible();
    await pause();
    await dialog.getByText("node:test").click();
    await pause(1500);
    if (await dialog.isVisible()) await page.getByTestId("extension-dialog-submit").click();
    await pause();

    await caption(page, "6/12", "confirm() → modal; click Confirm");
    await runCommand(page, "/demo-confirm");
    await expect(dialog).toBeVisible();
    await pause();
    await page.getByTestId("extension-dialog-confirm").click();
    await pause();

    await caption(page, "7/12", "input() → modal with a text field");
    await runCommand(page, "/demo-input");
    await expect(dialog).toBeVisible();
    await pause(1500);
    await dialog.locator("input, textarea").first().fill("feature/extension-ui");
    await pause(1500);
    await page.getByTestId("extension-dialog-submit").click();
    await pause();

    await caption(page, "8/12", "editor() → modal with a multi-line editor");
    await runCommand(page, "/demo-editor");
    await expect(dialog).toBeVisible();
    await pause(1500);
    await dialog.locator("textarea").first().fill("## Summary\n\n- Adds the demo extension");
    await pause(1500);
    await page.getByTestId("extension-dialog-submit").click();
    await pause();

    await caption(page, "9/12", "setEditorText() → replaces the composer draft");
    await runCommand(page, "/demo-editor-text");
    await pause(3000);
    await page.getByTestId("composer").fill("");

    await caption(page, "10/12", "custom() → unsupported: command marked terminal-only");
    await runCommand(page, "/demo-custom");
    await pause(3500);
    await page.getByTestId("composer").fill("/demo-cu");
    await pause(3000);
    await page.getByTestId("composer").fill("");

    await caption(page, "11/12", "sendMessage() custom message vs appendEntry() entry");
    await runCommand(page, "/demo-message");
    await pause();
    await runCommand(page, "/demo-entry");
    await pause(3000);

    await caption(page, "12/12", "Settings → Extensions: the extension's page, its commands and the terminal-only badge");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await pause(1500);
    await page.getByRole("button", { name: "Skills and extensions", exact: true }).click();
    await pause(1500);
    const extTab = page.getByRole("tab", { name: /Extensions/ });
    await expect(extTab).toBeVisible();
    await extTab.click();
    await pause(2000);
    const card = page.getByTestId("extensions-list").getByRole("button", { name: /ui-demo/i }).first();
    await expect(card).toBeVisible();
    await card.click();
    await pause(5000);
  } finally {
    await harness.close();
  }
});
