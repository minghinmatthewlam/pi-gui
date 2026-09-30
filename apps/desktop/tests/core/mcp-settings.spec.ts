import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";

/** A tiny stdio MCP server; connecting writes `<markerDir>/initialized.txt`. */
const MCP_SERVER_FIXTURE = resolve(
  __dirname,
  "../../../../packages/pi-sdk-driver/test/fixtures/mcp-stdio-server.mjs",
);

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function openMcpSettings(window: Page) {
  await window.keyboard.press(desktopShortcut(","));
  await expect(window.getByTestId("settings-surface")).toBeVisible();
  await window.getByRole("button", { name: "MCP servers", exact: true }).click();
  await expect(window.locator(".view-header__title")).toHaveText("MCP servers");
}

test("adds, switches and removes an MCP server from Settings, editing mcp.json in place", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("mcp-settings-workspace");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  const mcpPath = join(agentDir, "mcp.json");
  const existing = {
    command: "existing-server",
    args: ["--port", "1"],
    env: { EXISTING_SECRET: "do-not-show-this" },
    exposure: "direct",
  };
  await writeFile(
    mcpPath,
    `${JSON.stringify({ autoEnableCodemode: true, mcpServers: { existing } }, null, 4)}\n`,
  );
  await mkdir(join(workspacePath, ".pi"), { recursive: true });
  await writeFile(
    join(workspacePath, ".pi", "mcp.json"),
    JSON.stringify({ mcpServers: { "project-docs": { url: "http://127.0.0.1:9/mcp" } } }),
  );
  const markerDir = join(userDataDir, "mcp-markers");

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await openMcpSettings(window);
    const surface = window.getByTestId("settings-surface");
    const row = (name: string) =>
      surface.locator(`[data-testid="mcp-server-row"][data-server-name="${name}"]`);

    await expect(row("existing")).toContainText("existing-server --port 1");
    await expect(row("project-docs")).toContainText("This project · http://127.0.0.1:9/mcp");
    await expect(row("project-docs").getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(surface).not.toContainText("do-not-show-this");

    await surface.getByLabel("Server name").fill("fixture");
    await surface.getByLabel("Server command").fill(process.execPath);
    await surface.getByLabel("Server arguments").fill(`"${MCP_SERVER_FIXTURE}" "${markerDir}"`);
    await surface.getByRole("button", { name: "Add server", exact: true }).click();
    await expect(row("fixture")).toBeVisible();
    await expect(surface.getByLabel("Server name")).toHaveValue("");

    const afterAdd = await readJson(mcpPath);
    expect(afterAdd).toEqual({
      autoEnableCodemode: true,
      mcpServers: {
        existing,
        fixture: { command: process.execPath, args: [MCP_SERVER_FIXTURE, markerDir] },
      },
    });
    expect(await readFile(mcpPath, "utf8")).toMatch(/^ {4}"autoEnableCodemode"/m);

    // A thread starts the servers in mcp.json, the same file terminal pi reads.
    await createNamedThread(window, "MCP thread");
    await expect.poll(() => existsSync(join(markerDir, "initialized.txt"))).toBe(true);
    await openMcpSettings(window);

    const fixtureSwitch = row("fixture").getByRole("switch", { name: "Enable fixture" });
    await expect(fixtureSwitch).toBeChecked();
    await fixtureSwitch.click();
    await expect(fixtureSwitch).not.toBeChecked();
    await expect(fixtureSwitch).toBeEnabled();
    expect((await readJson(mcpPath)).mcpServers).toEqual({
      existing,
      fixture: { command: process.execPath, args: [MCP_SERVER_FIXTURE, markerDir], enabled: false },
    });

    await fixtureSwitch.click();
    await expect(fixtureSwitch).toBeChecked();
    await expect(fixtureSwitch).toBeEnabled();
    expect((await readJson(mcpPath)).mcpServers).toEqual({
      existing,
      fixture: { command: process.execPath, args: [MCP_SERVER_FIXTURE, markerDir] },
    });

    const projectSwitch = row("project-docs").getByRole("switch", { name: "Enable project-docs" });
    await projectSwitch.click();
    await expect(projectSwitch).not.toBeChecked();
    await expect(projectSwitch).toBeEnabled();
    expect(await readJson(join(workspacePath, ".pi", "mcp.json"))).toEqual({
      mcpServers: { "project-docs": { url: "http://127.0.0.1:9/mcp", enabled: false } },
    });

    await row("fixture").getByRole("button", { name: "Remove" }).click();
    await expect(row("fixture")).toHaveCount(0);
    expect(await readJson(mcpPath)).toEqual({
      autoEnableCodemode: true,
      mcpServers: { existing },
    });

    const codemodeSwitch = surface.getByRole("switch", { name: "Code mode always on" });
    await expect(codemodeSwitch).not.toBeChecked();
    await codemodeSwitch.click();
    await expect(codemodeSwitch).toBeChecked();
    await expect(codemodeSwitch).toBeEnabled();
    expect((await readJson(join(agentDir, "settings.json"))).defaultTools).toEqual(["+codemode"]);
    await codemodeSwitch.click();
    await expect(codemodeSwitch).not.toBeChecked();
    await expect(codemodeSwitch).toBeEnabled();
    expect((await readJson(join(agentDir, "settings.json"))).defaultTools).toBeUndefined();
  } finally {
    await harness.close();
  }
});

test("rejects a server Settings cannot run and leaves mcp.json alone", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("mcp-settings-invalid-workspace");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  const mcpPath = join(agentDir, "mcp.json");

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await openMcpSettings(window);
    const surface = window.getByTestId("settings-surface");
    await expect(surface.getByTestId("mcp-servers-empty")).toContainText("~/.pi/agent/mcp.json");
    await expect(surface.getByTestId("mcp-servers-empty")).toContainText("/mcp");

    await surface.getByLabel("Server name").fill("local-file");
    await surface.getByRole("group", { name: "Server type" }).getByText("URL").click();
    await surface.getByLabel("Server URL").fill("file:///etc/passwd");
    await surface.getByRole("button", { name: "Add server", exact: true }).click();
    await expect(surface).toContainText("MCP server URL must be a valid http:// or https:// URL");
    await expect(surface.getByLabel("Server name")).toHaveValue("local-file");
    expect(existsSync(mcpPath)).toBe(false);
  } finally {
    await harness.close();
  }
});
