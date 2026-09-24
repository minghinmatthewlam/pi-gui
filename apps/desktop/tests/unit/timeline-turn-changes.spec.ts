import { execFile } from "node:child_process";
import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import type { TurnChangeSummary } from "../../contracts/review";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import { summarizeGitTreeChanges } from "../../electron/platform/files/git-review";
import { buildDisplayTimelineItems } from "../../src/features/conversation/timeline-turns";

const run = promisify(execFile);

const message = (id: string, role: "user" | "assistant"): TranscriptMessage => ({
  kind: "message",
  id,
  sourceMessageId: id,
  role,
  text: id,
  createdAt: "2026-09-24T00:00:00Z",
});
const tool = (id: string): TranscriptMessage => ({
  kind: "tool",
  id,
  callId: id,
  toolName: "write",
  status: "success",
  label: id,
  createdAt: "2026-09-24T00:00:00Z",
});
const turn = (checkpointId: string, entryIds: string[]): TurnChangeSummary => ({
  checkpointId,
  checkoutId: "checkout",
  entryIds,
  files: [{ path: "a.txt", lines: { added: 1, removed: 0 } }],
});

test("each turn's card follows that turn's last rows and precedes the next prompt", () => {
  const transcript = [
    message("u1", "user"),
    message("a1", "assistant"),
    tool("t1"),
    message("a1-final", "assistant"),
    message("u2", "user"),
    tool("t2"),
    message("u3", "user"),
    message("a3", "assistant"),
  ];
  const rows = buildDisplayTimelineItems(transcript, [
    turn("first", ["u1", "a1", "a1-final"]),
    // A turn whose only visible anchor is its prompt still ends after its tool rows.
    turn("second", ["u2", "tool-only-assistant"]),
    turn("unplaced", ["not-in-transcript"]),
  ]).map((row) => row.id);
  expect(rows).toEqual([
    "u1",
    "a1",
    "t1",
    "a1-final",
    "turn-changes:first",
    "u2",
    "t2",
    "turn-changes:second",
    "u3",
    "a3",
  ]);
});

test("tree summaries report per-file line counts, renames and binary files", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-gui-turn-summary-"));
  const git = (...args: string[]) =>
    run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  await git("init", "-q");
  await writeFile(join(repo, "edited.txt"), "one\ntwo\n");
  await writeFile(join(repo, "moved.txt"), "a\nb\nc\nd\ne\nf\n");
  await git("add", ".");
  const before = (await git("write-tree")).stdout.trim();
  await writeFile(join(repo, "edited.txt"), "one\n2\nthree\n");
  await rename(join(repo, "moved.txt"), join(repo, "renamed.txt"));
  await writeFile(join(repo, "image.bin"), Buffer.from([0, 1, 2, 0]));
  await writeFile(join(repo, "tab\tname.txt"), "x\n");
  await git("add", "-A");
  const after = (await git("write-tree")).stdout.trim();
  expect(await summarizeGitTreeChanges(repo, before, after)).toEqual([
    { path: "edited.txt", lines: { added: 2, removed: 1 } },
    { path: "image.bin", lines: null },
    { path: "renamed.txt", previousPath: "moved.txt", lines: { added: 0, removed: 0 } },
    { path: "tab\tname.txt", lines: { added: 1, removed: 0 } },
  ]);
});
