import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  getRealAuthConfig,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

/** A tiny stdio MCP server whose `write_marker` tool appends to `<markerDir>/called.txt`. */
const MCP_SERVER_FIXTURE = resolve(
  __dirname,
  "../../../../packages/pi-sdk-driver/test/fixtures/mcp-stdio-server.mjs",
);

test("a real model calls an MCP tool added in Settings, through code mode", async () => {
  test.setTimeout(240_000);
  const realAuth = getRealAuthConfig();
  test.skip(!realAuth.enabled, realAuth.skipReason);

  const provider = process.env.PI_GUI_PROVIDER?.trim() || "openai-codex";
  const model = process.env.PI_GUI_MODEL?.trim() || "gpt-5.6-luna";
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("live-mcp-codemode");
  const markerDir = join(userDataDir, "mcp-markers");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    realAuthSourceDir: realAuth.sourceDir,
    enabledModels: [`${provider}/${model}`],
  });

  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await window.getByRole("button", { name: "MCP servers", exact: true }).click();
    const surface = window.getByTestId("settings-surface");
    await surface.getByLabel("Server name").fill("fixture");
    await surface.getByLabel("Server command").fill(process.execPath);
    await surface.getByLabel("Server arguments").fill(`"${MCP_SERVER_FIXTURE}" "${markerDir}"`);
    await surface.getByRole("button", { name: "Add server", exact: true }).click();
    await expect(
      surface.locator('[data-testid="mcp-server-row"][data-server-name="fixture"]'),
    ).toBeVisible();
    await window.getByRole("button", { name: "Back to app" }).click();

    await createNamedThread(window, "MCP code mode");
    await expect.poll(() => existsSync(join(markerDir, "initialized.txt"))).toBe(true);

    const composer = window.getByTestId("composer");
    await composer.fill(
      "Call the write_marker tool of the MCP server named fixture with text LIVE_MCP_MARKER. After it succeeds, reply with exactly MCP_DONE.",
    );
    await composer.press("Enter");

    await expect(
      window.locator(".timeline-item--assistant .message__content").last(),
    ).toContainText("MCP_DONE", { timeout: 180_000 });
    expect(readFileSync(join(markerDir, "called.txt"), "utf8")).toContain("LIVE_MCP_MARKER");
    await expect(
      window.locator(".timeline-tool").filter({ hasText: /code ?mode/i }),
    ).not.toHaveCount(0);
  } finally {
    await harness.close();
  }
});
