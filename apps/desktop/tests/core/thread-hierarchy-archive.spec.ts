import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { OrchestrationChildThread } from "../../contracts/desktop-state";
import {
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  runOrchestrationRuntimeTool,
  seedAgentDir,
  seedNamedTextSessionFixture,
  selectSession,
} from "../helpers/electron-app";

test("children nest under their parent; the archive tool archives only finished own children, keeping history and drafts", async ({}, info) => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir("pi-hierarchy-archive-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("hierarchy-archive");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  const fixtures: { sessionId: string; title: string }[] = [];
  for (const title of [
    "主任务 A",
    "主任务 B",
    "已完成的子任务",
    "中断的子任务",
    "其他主任务的子任务",
    "被停止的子任务",
  ]) {
    fixtures.push(
      await seedNamedTextSessionFixture(agentDir, workspacePath, {
        title,
        userText: "隔离测试",
        assistantText: `${title} 的历史内容`,
      }),
    );
  }
  const [parent, otherParent, done, incomplete, foreign, stopped] = fixtures;
  if (!parent || !otherParent || !done || !incomplete || !foreign || !stopped)
    throw new Error("Missing fixtures");
  // Give each reply the stop reason a real provider writes. The stopped child's reply
  // was cut off by a user stop; the interrupted child got a follow-up it never answered.
  const sessionFiles = await readdir(join(agentDir, "sessions"), { recursive: true });
  for (const fixture of fixtures) {
    const name = sessionFiles.find(
      (file) => file.endsWith(".jsonl") && file.includes(fixture.sessionId),
    );
    if (!name) throw new Error("Fixture file not found");
    const path = join(agentDir, "sessions", name);
    const entries = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; message?: Record<string, unknown> });
    for (const entry of entries)
      if (entry.message?.role === "assistant")
        entry.message.stopReason = fixture === stopped ? "aborted" : "stop";
    if (fixture === incomplete) {
      const userEntry = entries.find((entry) => entry.message?.role === "user");
      if (!userEntry) throw new Error("Fixture user message not found");
      entries.push({
        ...userEntry,
        id: "unanswered-follow-up",
        parentId: entries.at(-1)?.id,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "继续完成剩下的工作", timestamp: Date.now() },
      } as (typeof entries)[number]);
    }
    await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  const now = new Date().toISOString();
  const children: OrchestrationChildThread[] = [done, incomplete, foreign, stopped].map(
    (child, index) => ({
      id: `child-${index}`,
      parentWorkspaceId: workspacePath,
      parentSessionId: index === 2 ? otherParent.sessionId : parent.sessionId,
      childWorkspaceId: workspacePath,
      childSessionId: child.sessionId,
      title: child.title,
      goal: "隔离测试",
      status: "complete",
      latestTranscript: "fixture",
      transcript: [],
      evidence: [],
      createdAt: now,
      updatedAt: now,
    }),
  );
  await writeFile(
    join(userDataDir, "ui-state.json"),
    JSON.stringify({
      version: 19,
      selectedWorkspaceId: workspacePath,
      selectedSessionId: parent.sessionId,
      orchestrationChildren: children,
    }),
  );
  const launch = () =>
    launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      testMode: "background",
      scrubProviderEnv: true,
    });
  let harness = await launch();
  try {
    let window = await harness.firstWindow();
    const group = window.getByRole("group", { name: "Children of 主任务 A", exact: true });
    await expect(group.locator(".session-row")).toHaveCount(3);
    await expect(group).toContainText(done.title);
    await expect(group).not.toContainText(foreign.title);
    // Collapse the parent of the selected child; later state pushes must not reopen it.
    await selectSession(window, done.title);
    await window
      .getByRole("button", { name: "Collapse children of 主任务 A", exact: true })
      .click();
    await expect(group).toHaveCount(0);
    const otherParentRow = window.locator(
      `.session-row[data-session-id="${otherParent.sessionId}"]`,
    );
    await otherParentRow.hover();
    await otherParentRow.getByRole("button", { name: /^Pin / }).click();
    await expect(otherParentRow).toHaveAttribute("data-session-pinned", "true");
    await otherParentRow.hover();
    await otherParentRow.getByRole("button", { name: /^Unpin / }).click();
    await expect(otherParentRow).toHaveAttribute("data-session-pinned", "false");
    await expect(group).toHaveCount(0);
    // Renaming the selected child from the keyboard reopens its collapsed parent.
    await window.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+R`);
    await expect(window.getByLabel(`Rename thread ${done.title}`)).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(group).toBeVisible();
    await window
      .getByRole("button", { name: "Collapse children of 主任务 A", exact: true })
      .click();
    await window.getByRole("button", { name: "Expand children of 主任务 A", exact: true }).click();
    await expect(group).toBeVisible();
    const doneRow = window.locator(`.session-row[data-session-id="${done.sessionId}"]`);
    await doneRow.hover();
    await doneRow.getByRole("button", { name: new RegExp(`^Pin ${done.title}`) }).click();
    await expect(
      window.locator(`.session-list--pinned .session-row[data-session-id="${done.sessionId}"]`),
    ).toBeVisible();
    await expect(group.locator(".session-row")).toHaveCount(2);
    await doneRow.hover();
    await doneRow.getByRole("button", { name: new RegExp(`^Unpin ${done.title}`) }).click();
    await expect(group.locator(`.session-row[data-session-id="${done.sessionId}"]`)).toBeVisible();
    await selectSession(window, done.title);
    const history = await getSelectedTranscript(window);
    const childDraft = "中文草稿：归档和恢复后继续复核。";
    await window.getByTestId("composer").fill(childDraft);
    await selectSession(window, parent.title);
    const parentDraft = "主任务草稿：不要改变正在运行的工作。";
    await window.getByTestId("composer").fill(parentDraft);
    await window.screenshot({ path: info.outputPath("hierarchy.png") });
    // The user is looking at the finished child when the parent's agent archives it.
    await selectSession(window, done.title);
    await expect(window.getByTestId("composer")).toHaveValue(childDraft);
    const parentRef = { workspaceId: workspacePath, sessionId: parent.sessionId };
    const result = await runOrchestrationRuntimeTool(harness, {
      sessionRef: parentRef,
      toolName: "archive_child_threads",
      params: { thread_ids: ["child-0", "child-1", "child-2", "child-3", parent.sessionId] },
    });
    await info.attach("archive-result", {
      body: JSON.stringify(result.details),
      contentType: "application/json",
    });
    expect(result.details?.archived, JSON.stringify(result.details)).toEqual(["child-0"]);
    const notOwn = "Only direct child threads of this thread can be archived.";
    expect(result.details?.skipped).toEqual([
      {
        threadId: "child-1",
        reason: "Child thread's last turn did not end with a reply; it was not archived.",
      },
      { threadId: "child-2", reason: notOwn },
      {
        threadId: "child-3",
        reason: "Child thread's last run was stopped before it finished; it was not archived.",
      },
      { threadId: parent.sessionId, reason: notOwn },
    ]);
    await expect(group.locator(".session-row")).toHaveCount(2);
    // The agent's archive leaves the user's selection, transcript, and draft alone.
    expect((await getDesktopState(window)).selectedSessionId).toBe(done.sessionId);
    await expect(window.getByTestId("composer")).toHaveValue(childDraft);
    expect(await getSelectedTranscript(window)).toEqual(history);
    await selectSession(window, parent.title);
    await expect(window.getByTestId("composer")).toHaveValue(parentDraft);
    const listed = await runOrchestrationRuntimeTool(harness, {
      sessionRef: parentRef,
      toolName: "list_threads",
      params: {},
    });
    expect(JSON.stringify(listed.details)).not.toContain('"childThreadId":"child-0"');
    const repeat = await runOrchestrationRuntimeTool(harness, {
      sessionRef: parentRef,
      toolName: "archive_child_threads",
      params: { thread_ids: ["child-0"] },
    });
    expect(repeat.details?.archived).toEqual([]);
    const before = await getDesktopState(window);
    expect(before.orchestrationChildren).toHaveLength(4);
    expect(
      before.workspaces
        .flatMap((ws) => ws.sessions)
        .filter((s) => s.archivedAt)
        .map((s) => s.id),
    ).toEqual([done.sessionId]);
    await harness.close();
    harness = await launch();
    window = await harness.firstWindow();
    await expect(window.getByTestId("composer")).toHaveValue(parentDraft);
    await window.locator(".archived-thread-group__toggle").click();
    const archived = window.locator(
      `.session-list--archived .session-row[data-session-id="${done.sessionId}"]`,
    );
    await expect(archived).toBeVisible();
    await archived.hover();
    await archived.getByRole("button", { name: new RegExp(`^Restore ${done.title}`) }).click();
    await expect(
      window
        .getByRole("group", { name: "Children of 主任务 A", exact: true })
        .locator(".session-row"),
    ).toHaveCount(3);
    await selectSession(window, done.title);
    await expect(window.getByTestId("composer")).toHaveValue(childDraft);
    expect(await getSelectedTranscript(window)).toEqual(history);
    expect((await getDesktopState(window)).orchestrationChildren).toHaveLength(4);
  } finally {
    await harness.close();
  }
});
