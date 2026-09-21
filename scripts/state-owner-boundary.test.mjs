import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ownerFiles = [
  "apps/desktop/electron/conversation/app-store-composer.ts",
  "apps/desktop/electron/workspace/app-store-workspace.ts",
  "apps/desktop/electron/workspace/app-store-worktree.ts",
  "apps/desktop/electron/orchestration/app-store-orchestration.ts",
  "apps/desktop/electron/scheduled-tasks/app-store-scheduled-tasks.ts",
];

function ownershipViolations(filePath, source) {
  const violations = [];
  if (/AppStoreInternals|app-store-internals/.test(source)) {
    violations.push(`${filePath}: imports the removed whole-store interface`);
  }
  if (/\bstore\.(?:state|sessionState|runtimeByWorkspace)\b/.test(source)) {
    violations.push(`${filePath}: reaches through an owner into unrelated mutable state`);
  }
  if (
    /\b(?:conversation|workspace|worktree|orchestration)\.[A-Za-z0-9_]+\(this(?:\s*[,)]|\s*=>)/.test(
      source,
    )
  ) {
    violations.push(`${filePath}: passes DesktopAppStore into a method group`);
  }
  return violations;
}

test("the state-owner guard rejects the former whole-store shortcut", () => {
  assert.deepEqual(
    ownershipViolations(
      "invalid.ts",
      `import type { AppStoreInternals } from "./app-store-internals";
       function rename(store: AppStoreInternals) { store.state.selectedSessionId = "next"; }`,
    ),
    [
      "invalid.ts: imports the removed whole-store interface",
      "invalid.ts: reaches through an owner into unrelated mutable state",
    ],
  );
});

test("desktop state owners expose only their bounded operation ports", () => {
  const removedInterface = path.join(
    root,
    "apps/desktop/electron/application/app-store-internals.ts",
  );
  assert.equal(existsSync(removedInterface), false, "remove the whole-store interface");

  const appStorePath = "apps/desktop/electron/application/app-store.ts";
  const appStore = readFileSync(path.join(root, appStorePath), "utf8");
  const violations = ownershipViolations(appStorePath, appStore);
  for (const filePath of ownerFiles) {
    violations.push(
      ...ownershipViolations(filePath, readFileSync(path.join(root, filePath), "utf8")),
    );
  }
  assert.deepEqual(violations, []);

  for (const field of ["state", "driver", "catalogStore", "sessionState", "runtimeByWorkspace"]) {
    assert.match(
      appStore,
      new RegExp(`private(?: readonly)? ${field}\\b`),
      `${field} must remain private to DesktopAppStore`,
    );
  }
});
