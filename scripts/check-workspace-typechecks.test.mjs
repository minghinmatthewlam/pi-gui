import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkWorkspaceTypechecks } from "./check-workspace-typechecks.mjs";

test("pnpm discovery catches a new workspace without a typecheck command", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-gui-workspaces-"));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", private: true }),
  );
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - modules/*\n");
  const workspace = path.join(root, "modules/new-workspace");
  mkdirSync(workspace, { recursive: true });
  const manifest = path.join(workspace, "package.json");
  for (const scripts of [{}, { typecheck: " " }]) {
    writeFileSync(manifest, JSON.stringify({ name: "new-workspace", scripts }));
    const result = checkWorkspaceTypechecks(root, process.env.npm_execpath);
    assert.equal(result.count, 1);
    assert.match(
      result.failures.join("\n"),
      /modules\/new-workspace\/package.json: missing scripts.typecheck/,
    );
  }
  writeFileSync(
    manifest,
    JSON.stringify({ name: "new-workspace", scripts: { typecheck: "tsc --noEmit" } }),
  );
  assert.deepEqual(checkWorkspaceTypechecks(root, process.env.npm_execpath).failures, []);
});
