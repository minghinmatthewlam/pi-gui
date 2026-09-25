import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createSessionViaIpc,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  type DesktopHarness,
} from "../helpers/electron-app";

async function findLeaseFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.filter((entry) => entry.endsWith(".jsonl.lease")).map((entry) => join(dir, entry));
}

async function leaseHolderPid(leasePath: string): Promise<number | undefined> {
  try {
    return (JSON.parse(await readFile(leasePath, "utf8")) as { pid?: number }).pid;
  } catch {
    return undefined;
  }
}

/**
 * Two pi-gui processes (separate user-data dirs, so the single-instance lock
 * does not stop the second) share one pi agent dir. The first holds a thread
 * open; the second must refuse to open it until the first quits.
 */
test("a second pi-gui process cannot open a thread the first one holds", async () => {
  test.setTimeout(120_000);
  const agentDir = await makeUserDataDir("pi-gui-shared-agent-");
  const workspacePath = await makeWorkspace("lease-workspace");
  const title = "Shared lease thread";

  const first = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspacePath],
    agentDir,
    testMode: "background",
  });
  let second: DesktopHarness | undefined;
  try {
    const firstWindow = await first.firstWindow();
    await createSessionViaIpc(firstWindow, workspacePath, title);
    await expect.poll(() => findLeaseFiles(agentDir)).toHaveLength(1);

    second = await launchDesktop(await makeUserDataDir(), {
      initialWorkspaces: [workspacePath],
      agentDir,
      testMode: "background",
    });
    const secondWindow = await second.firstWindow();
    const secondRow = secondWindow.locator(".session-row__select", { hasText: title });
    await expect(secondRow).toBeVisible({ timeout: 20_000 });
    await secondRow.click();
    await expect(secondWindow.getByTestId("composer-error-banner")).toContainText(
      "This session is currently open in another pi instance",
    );

    const [leasePath] = await findLeaseFiles(agentDir);
    const firstPid = first.electronApp.process().pid;
    expect(await leaseHolderPid(leasePath)).toBe(firstPid);

    // Once the holder quits its lease is dead, so the thread opens here and
    // this process takes the lease over.
    await first.close();
    await selectSession(secondWindow, title);
    await expect(secondWindow.getByTestId("composer-error-banner")).toHaveCount(0);
    await expect.poll(() => leaseHolderPid(leasePath)).toBe(second.electronApp.process().pid);
  } finally {
    await second?.close();
    await first.close().catch(() => {});
  }
});
