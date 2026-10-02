import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSession,
  waitForTimelineLayout,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

const PROVIDER_ID = "card-actions-test";
const MODEL_ID = "scripted";
const THREAD_TITLE = "Card buttons";

// A CI extension that keeps one card up to date by writing it again under the same key, with
// one button of each kind. Two buttons name things that are not extension commands: main must
// refuse both without a model turn. The model replies "MODEL RAN" if anything reaches it.
const extensionSource = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function ciButtons(pi) {
  const publish = (passing) =>
    pi.appendEntry("pi-gui.card", {
      key: "ci-main",
      title: passing ? "CI passed on main" : "CI failed on main",
      subtitle: passing ? "unit-tests · 42 passed" : "unit-tests · 2 failed, 40 passed",
      tone: passing ? "success" : "error",
      actions: passing
        ? []
        : [
            { type: "openFile", label: "Open failing line", path: "search.ts", line: 3 },
            { type: "composer", label: "Ask pi to fix it", text: "Fix the failing search test." },
            { type: "command", label: "Rerun CI", command: "/ci rerun" },
            { type: "url", label: "Open the run", url: "https://ci.example.com/runs/7" },
            { type: "command", label: "Switch model", command: "/model" },
            { type: "command", label: "Not a command", command: "/not-registered please" },
          ],
    });
  pi.registerCommand("ci", {
    description: "Show CI for main",
    handler: async (args) => publish(args.trim() === "rerun"),
  });
  pi.registerProvider("card-actions-test", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "card-actions-test",
    models: [{
      id: "scripted",
      name: "Scripted",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model) {
      const done = {
        role: "assistant",
        content: [{ type: "text", text: "MODEL RAN" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: done });
        stream.push({ type: "done", reason: "stop", message: done });
      });
      return stream;
    },
  });
}
`;

test("card buttons run through main: a keyed card updates in place, and non-extension commands are refused", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("extension-card-actions");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: PROVIDER_ID,
      defaultModel: MODEL_ID,
      enabledModels: [`${PROVIDER_ID}/${MODEL_ID}`],
      packages: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
  );
  await writeFile(
    join(workspacePath, "search.ts"),
    [
      "export function search(items: string[], query: string): string[] {",
      "  const needle = query.trim().toLowerCase();",
      "  return items.filter((item) => item.toLowerCase().includes(needle));",
      "}",
      "",
    ].join("\n"),
  );
  await writeProjectExtension(workspacePath, "ci-buttons.ts", extensionSource);
  const launch = () =>
    launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      scrubProviderEnv: true,
      testMode: "background",
    });

  const firstRun = await launch();
  try {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, THREAD_TITLE);
    const composer = window.getByTestId("composer");
    await composer.click();
    await composer.fill("/ci ");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");

    const card = window.getByTestId("extension-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("CI failed on main");
    await expect(card.getByRole("button", { name: /Open the run/ })).toContainText(
      "ci.example.com",
    );
    await expect(card.getByRole("button", { name: /Rerun CI/ })).toContainText("/ci rerun");

    // The composer button adds text below the user's draft and sends nothing.
    await composer.fill("My own draft");
    await waitForTimelineLayout(window);
    await card.getByRole("button", { name: /Ask pi to fix it/ }).click();
    await expect(composer).toHaveValue("My own draft\nFix the failing search test.");
    await expect(composer).toBeFocused();

    // Neither refused command reaches the model, and the draft is untouched.
    const notices = window.getByTestId("extension-notice");
    await card.getByRole("button", { name: /Switch model/ }).click();
    await expect(notices.filter({ hasText: "/model is not an extension command" })).toBeVisible();
    await card.getByRole("button", { name: /Not a command/ }).click();
    await expect(
      notices.filter({ hasText: "/not-registered is not an extension command" }),
    ).toBeVisible();
    await expect(window.locator(".timeline-item--assistant")).toHaveCount(0);
    await expect(window.getByText("MODEL RAN")).toHaveCount(0);
    await expect(composer).toHaveValue("My own draft\nFix the failing search test.");

    // The extension command runs and rewrites the card under its key. It is not a message:
    // no bubble joins the thread and the draft stays.
    const userRows = window.locator(".timeline-item--user");
    const userRowsBefore = await userRows.count();
    await card.getByRole("button", { name: /Rerun CI/ }).click();
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("CI passed on main");
    await expect(card.locator(".extension-card__tone")).toHaveText("Passed");
    await expect(composer).toHaveValue("My own draft\nFix the failing search test.");
    await expect(window.locator(".timeline-item--assistant")).toHaveCount(0);
    await expect(userRows).toHaveCount(userRowsBefore);
  } finally {
    await firstRun.close();
  }

  const secondRun = await launch();
  try {
    const window = await secondRun.firstWindow();
    await selectSession(window, THREAD_TITLE);
    const card = window.getByTestId("extension-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("CI passed on main");

    // Back to the failing card: its open-file button opens the checked file at the line.
    const composer = window.getByTestId("composer");
    await composer.fill("/ci ");
    await composer.press("Enter");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("CI failed on main");
    await waitForTimelineLayout(window);
    await card.getByRole("button", { name: /Open failing line/ }).click();
    await expect(window.getByTestId("file-workbench")).toBeVisible();
    const lineThree = window.locator('[data-testid="file-line-mark"][data-line="3"]');
    await expect(lineThree).toHaveCount(1);
    await expect(lineThree).toContainText("items.filter");
  } finally {
    await secondRun.close();
  }
});
