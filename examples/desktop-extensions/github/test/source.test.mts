import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { issueDraft, pullRequestDraft } from "../drafts.ts";
import { loadRepository, readSnapshot, summarizeChecks } from "../source.ts";

const snapshotPath = fileURLToPath(new URL("../fixtures/pi-gui-snapshot.json", import.meta.url));
const signal = new AbortController().signal;

// A fake `gh` that answers the fixed argv the extension sends and records each call.
async function fakeGh(responses: Record<string, unknown>, exitWith?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-gui-github-example-"));
  const path = join(directory, "gh");
  await writeFile(
    path,
    `#!/usr/bin/env node
const responses = ${JSON.stringify(responses)};
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(join(directory, "calls.log"))}, JSON.stringify(args) + "\\n");
${exitWith ? `process.stderr.write(${JSON.stringify(exitWith)}); process.exit(1);` : ""}
const key = args[0] === "repo" ? "repo" : args[0] + ":" + args[args.indexOf("--state") + 1];
process.stdout.write(JSON.stringify(responses[key] ?? []));
`,
  );
  await chmod(path, 0o755);
  return path;
}

const ghPr = {
  number: 7,
  title: "Fix search",
  state: "OPEN",
  isDraft: false,
  author: { login: "octo" },
  headRefName: "fix-search",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z",
  reviewDecision: "CHANGES_REQUESTED",
  url: "https://github.com/acme/app/pull/7",
  additions: 12,
  deletions: 3,
  statusCheckRollup: [
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "StatusContext", context: "deploy", state: "ERROR" },
  ],
};

test("live data comes from gh with fixed arguments and is normalized", async () => {
  const gh = await fakeGh({
    repo: { nameWithOwner: "acme/app" },
    "pr:open": [ghPr],
    "pr:closed": [{ ...ghPr, number: 5, state: "MERGED", statusCheckRollup: [] }],
    "issue:open": [
      {
        number: 9,
        title: "Crash on start",
        state: "OPEN",
        author: { login: "sam" },
        labels: [{ name: "bug" }],
        comments: [{ body: "same" }, { body: "+1" }],
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-03T00:00:00Z",
        body: "<!-- template -->\nSteps:\n\n\n\n1. open <b>app</b>",
        url: "https://github.com/acme/app/issues/9",
      },
    ],
  });
  const loaded = await loadRepository({
    cwd: tmpdir(),
    signal,
    env: { PATH: process.env.PATH },
    fallbackSnapshot: snapshotPath,
    gh,
  });
  assert.equal(loaded.repo, "acme/app");
  assert.deepEqual(loaded.source, { kind: "live" });
  const [pr, merged] = loaded.pullRequests;
  assert.equal(pr.number, 7);
  assert.equal(pr.review, "changes_requested");
  assert.deepEqual(pr.checks, {
    state: "failing",
    failed: ["test", "deploy"],
    passed: 1,
    total: 3,
  });
  assert.equal(merged.state, "merged");
  assert.equal(merged.checks.state, "none");
  const [issue] = loaded.issues;
  assert.deepEqual(issue.labels, ["bug"]);
  assert.equal(issue.comments, 2);
  // Template comments are dropped; markup stays inert text for textContent rendering.
  assert.equal(issue.body, "Steps:\n\n1. open <b>app</b>");
  const calls = (await readFile(join(dirname(gh), "calls.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(calls[0], ["repo", "view", "--json", "nameWithOwner"]);
  assert.deepEqual(
    calls
      .slice(1)
      .map((args) => args.slice(0, 6).join(" "))
      .sort(),
    [
      "issue list --state closed --limit 25",
      "issue list --state open --limit 50",
      "pr list --state closed --limit 25",
      "pr list --state open --limit 50",
    ],
  );
});

test("a missing gh falls back to the saved snapshot and says why", async () => {
  const loaded = await loadRepository({
    cwd: tmpdir(),
    signal,
    env: { PATH: process.env.PATH },
    fallbackSnapshot: snapshotPath,
    gh: join(tmpdir(), "definitely-not-gh-7f3a"),
  });
  assert.equal(loaded.repo, "minghinmatthewlam/pi-gui");
  assert.deepEqual(loaded.source, {
    kind: "snapshot",
    capturedAt: "2026-09-30T20:50:00Z",
    reason: "gh-missing",
  });
});

test("PI_GUI_GITHUB_FIXTURE selects a snapshot without running gh", async () => {
  const loaded = await loadRepository({
    cwd: tmpdir(),
    signal,
    env: { PI_GUI_GITHUB_FIXTURE: snapshotPath },
    fallbackSnapshot: "/nonexistent",
    gh: "/nonexistent/gh",
  });
  assert.equal(loaded.source.kind, "snapshot");
  assert.ok(loaded.pullRequests.some((pr) => pr.number === 223));
});

test("a folder without a GitHub remote explains itself instead of falling back", async () => {
  const gh = await fakeGh(
    {},
    "fatal: not a git repository (or any of the parent directories): .git",
  );
  await assert.rejects(
    loadRepository({
      cwd: tmpdir(),
      signal,
      env: { PATH: process.env.PATH },
      fallbackSnapshot: snapshotPath,
      gh,
    }),
    /isn't a GitHub repository/,
  );
});

test("check rollups distinguish pending, passing and none", () => {
  assert.equal(summarizeChecks([]).state, "none");
  assert.equal(
    summarizeChecks([{ name: "a", status: "IN_PROGRESS", conclusion: "" }]).state,
    "pending",
  );
  assert.equal(
    summarizeChecks([{ name: "a", status: "COMPLETED", conclusion: "SKIPPED" }]).state,
    "passing",
  );
});

test("drafts reference the issue or PR and never ask to post to GitHub", async () => {
  const snapshot = await readSnapshot(snapshotPath);
  const issue = snapshot.issues.find((candidate) => candidate.number === 216)!;
  const fix = issueDraft(snapshot.repo, issue);
  assert.equal(fix.title, "Fix #216: Model name change randomly");
  assert.match(fix.prompt, /https:\/\/github\.com\/minghinmatthewlam\/pi-gui\/issues\/216/);
  assert.match(fix.prompt, /> After sending a couple of prompts/);
  const failing = snapshot.pullRequests.find((candidate) => candidate.number === 223)!;
  const ci = pullRequestDraft(snapshot.repo, failing);
  assert.equal(ci.title, "Fix failing CI on PR #223");
  assert.match(ci.prompt, /- desktop-package-linux\n- typecheck/);
  const passing = snapshot.pullRequests.find((candidate) => candidate.number === 222)!;
  assert.match(pullRequestDraft(snapshot.repo, passing).title, /^Review PR #222: /);
  for (const draft of [fix, ci]) assert.match(draft.prompt, /Don't/);
});
