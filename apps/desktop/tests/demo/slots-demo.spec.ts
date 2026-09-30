import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  writeProjectExtension,
} from "../helpers/electron-app";
import { caption, runCommand } from "./_demo-helpers";

// Slot catalogue demo: one plain pi extension fills three slots (badge, card, panel) with data
// and uses the fixed action list (open file, composer text, command, panel, url).
const extensionSource = String.raw`
export default function ciWatch(pi) {
  const failedTest = "search.test.ts › returns [] for a blank query";
  const publish = (state) => {
    const failing = state === "failing";
    pi.appendEntry("pi-gui.badge", {
      key: "ci",
      text: failing ? "CI failing" : "CI passing",
      tone: failing ? "error" : "success",
    });
    pi.appendEntry("pi-gui.card", {
      key: "ci-main",
      title: failing ? "CI failed on main" : "CI passed on main",
      subtitle: failing ? "unit-tests · 1 failed, 41 passed · 1m 12s" : "unit-tests · 42 passed · 1m 04s",
      tone: failing ? "error" : "success",
      rows: failing
        ? [{ label: "Failed", value: failedTest }, { label: "Commit", value: "a1b2c3d fix: trim search input" }]
        : [{ label: "Commit", value: "a1b2c3d fix: trim search input" }],
      actions: failing
        ? [
            { type: "openFile", label: "Open failing test", path: "search.ts", line: 3 },
            { type: "panel", label: "See test results", key: "ci-results" },
            { type: "composer", label: "Ask pi to fix", text: "Fix the failing test " + failedTest + " and re-run /ci" },
            { type: "command", label: "Re-run CI", command: "/ci rerun" },
            { type: "url", label: "Open run", url: "https://ci.example.com/runs/8123" },
          ]
        : [{ type: "url", label: "Open run", url: "https://ci.example.com/runs/8124" }],
    });
    pi.appendEntry("pi-gui.panel", {
      key: "ci-results",
      title: "Test results",
      actions: [{ type: "command", label: "Re-run", command: "/ci rerun" }],
      sections: [
        ...(failing
          ? [{ title: "Failed", rows: [{ label: failedTest, value: "12 ms", tone: "error",
                actions: [{ type: "openFile", label: "Open", path: "search.ts", line: 3 }] }] }]
          : []),
        { title: "Passed", rows: [
          { label: "search.test.ts › finds exact matches", value: "3 ms", tone: "success" },
          { label: "search.test.ts › ignores case", value: "2 ms", tone: "success" },
          { label: "index.test.ts › builds the index", value: "41 ms", tone: "success" },
        ] },
      ],
    });
  };
  pi.registerCommand("ci", {
    description: "Show the latest CI result",
    handler: async (args) => { publish(args.trim() === "rerun" ? "passing" : "failing"); },
  });
}
`;

test("records the slot catalogue demo", async () => {
  test.setTimeout(240_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  const workspacePath = await makeWorkspace("slots-demo-workspace");
  await writeFile(
    join(workspacePath, "search.ts"),
    "export function search(items: string[], query: string): string[] {\n  const needle = query.toLowerCase();\n  return items.filter((item) => item.toLowerCase().includes(needle));\n}\n",
  );
  await writeProjectExtension(workspacePath, "ci-watch.ts", extensionSource);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    envOverrides: { PI_APP_TEST_MODE: undefined },
  });
  try {
    await harness.focusWindow();
    const page = await harness.firstWindow();
    await page.waitForTimeout(1500);
    await createNamedThread(page, "Slots demo: CI watch");
    await page.waitForTimeout(1200);
    const pause = (ms = 2500) => page.waitForTimeout(ms);

    await caption(page, "Slots · 1/6", "One plain pi extension. Three slots, each one data record: badge, card, panel.",
`pi.appendEntry("pi-gui.badge", { key: "ci", text: "CI failing", tone: "error" });
pi.appendEntry("pi-gui.card",  { key: "ci-main", title: "CI failed on main", rows, actions });
pi.appendEntry("pi-gui.panel", { key: "ci-results", title: "Test results", sections });`);
    await pause(5000);

    await caption(page, "Slots · 2/6", "/ci → badge on the thread header and sidebar row, card in the transcript");
    await runCommand(page, "/ci");
    await expect(page.getByTestId("extension-card")).toBeVisible();
    await expect(page.getByTestId("extension-badge").first()).toBeVisible();
    await pause(4000);

    await caption(page, "Slots · 3/6", "Actions are a fixed list. 'See test results' opens the extension's panel as a side-panel tab");
    await page.getByRole("button", { name: "See test results" }).click();
    await expect(page.getByTestId("extension-panel")).toBeVisible();
    await pause(4500);

    await caption(page, "Slots · 4/6", "'Ask pi to fix' puts text in the composer; you decide to send it");
    await page.getByRole("button", { name: "Ask pi to fix" }).click();
    await expect(page.getByTestId("composer")).toHaveValue(/Fix the failing test/);
    await pause(3500);
    await page.getByTestId("composer").fill("");

    await caption(page, "Slots · 5/6", "'Re-run CI' runs the extension's own /ci command, no model turn. Same key → the card, badge and panel update in place");
    await page.getByRole("button", { name: "Re-run CI" }).click();
    await expect(page.getByTestId("extension-card")).toContainText("CI passed on main");
    await expect(page.getByTestId("extension-badge").first()).toContainText("CI passing");
    await pause(4500);

    await caption(page, "Slots · 6/6", "Terminal pi runs the same file; it just shows nothing for pi-gui.* entries.");
    await pause(3500);
  } finally {
    await harness.close();
  }
});
