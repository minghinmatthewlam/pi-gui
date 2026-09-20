import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertWorkflowActionPolicy, isAction } from "./workflow-action-policy.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

test("isAction matches the action name and ignores the ref", () => {
  assert.equal(isAction("actions/upload-artifact@v7", "actions/upload-artifact"), true);
  assert.equal(isAction("actions/upload-artifact@v4", "actions/upload-artifact"), true);
  assert.equal(isAction("softprops/action-gh-release@v3", "actions/upload-artifact"), false);
  assert.equal(isAction(undefined, "actions/upload-artifact"), false);
});

test("the repository workflows match the Node 24 action policy", async () => {
  await assertWorkflowActionPolicy(repoRoot);
});

test("valid six-action corpus passes", async () => {
  await assertWorkflowActionPolicy(await writeFixture(validWorkflow()));
});

test("stale Node 20 majors fail", async () => {
  const root = await writeFixture(
    validWorkflow().replace("actions/checkout@v7", "actions/checkout@v4"),
  );
  await assert.rejects(() => assertWorkflowActionPolicy(root), /actions\/checkout@v7/);
});

test("setup-node v5 is not an allowed major", async () => {
  const root = await writeFixture(
    validWorkflow().replace("actions/setup-node@v7", "actions/setup-node@v5"),
  );
  await assert.rejects(() => assertWorkflowActionPolicy(root), /setup-node@v7/);
});

test("download-artifact must pair with upload-artifact v7 as v8", async () => {
  const root = await writeFixture(
    validWorkflow().replace("actions/download-artifact@v8", "actions/download-artifact@v7"),
  );
  await assert.rejects(() => assertWorkflowActionPolicy(root), /download-artifact@v8/);
});

test("unknown remote actions fail closed", async () => {
  const root = await writeFixture(`${validWorkflow()}      - uses: actions/cache@v4
`);
  await assert.rejects(() => assertWorkflowActionPolicy(root), /unknown remote action/);
});

test("SHA refs are not accepted", async () => {
  const root = await writeFixture(
    validWorkflow().replace(
      "actions/checkout@v7",
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    ),
  );
  await assert.rejects(() => assertWorkflowActionPolicy(root), /expected actions\/checkout@v7/);
});

test("setup-node must keep application Node 22", async () => {
  const root = await writeFixture(validWorkflow().replace("node-version: 22", "node-version: 24"));
  await assert.rejects(() => assertWorkflowActionPolicy(root), /node-version must be 22/);
});

test("jobs that install pnpm must cache pnpm and jobs that do not must omit cache", async () => {
  const missingCache = await writeFixture(validWorkflow().replace("\n          cache: pnpm", ""));
  await assert.rejects(() => assertWorkflowActionPolicy(missingCache), /must set cache: pnpm/);

  const extraCache = await writeFixture(
    validWorkflow().replace(
      `  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
`,
      `  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: pnpm
`,
    ),
  );
  await assert.rejects(() => assertWorkflowActionPolicy(extraCache), /must omit cache/);
});

test("runtime shims are rejected", async () => {
  const root = await writeFixture(`name: shim
on: push
env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: pnpm
      - uses: actions/upload-artifact@v7
        with:
          path: out
      - uses: actions/download-artifact@v8
        with:
          name: out
      - uses: softprops/action-gh-release@v3
`);
  await assert.rejects(
    () => assertWorkflowActionPolicy(root),
    /FORCE_JAVASCRIPT_ACTIONS_TO_NODE24/,
  );
});

function validWorkflow() {
  return `name: valid
on: push
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: pnpm
      - uses: actions/upload-artifact@v7
        with:
          path: out
      - uses: actions/download-artifact@v8
        with:
          name: out
      - uses: softprops/action-gh-release@v3
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
`;
}

/**
 * @param {string} workflow
 */
async function writeFixture(workflow) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-gui-action-policy-"));
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(root, ".github", "workflows", "ci.yml"), workflow);
  return root;
}
