import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

const reviewedStore = "apps/desktop/electron/workbench/reviewed-store.ts";
const checkpointStore = "apps/desktop/electron/workbench/checkpoint-store.ts";
// Durable files and the atomic writer may appear only in the modules that own them.
const durableStateOwners = [
  { token: /reviewed-files\.json/, name: "reviewed-files.json", owners: [reviewedStore] },
  {
    token: /\bturn-checkpoints\b|\bcheckpoints\.json|\bobjects\.git\b/,
    name: "the checkpoint store paths",
    owners: [checkpointStore],
  },
  {
    token: /\bwriteFileAtomicQueued\b/,
    name: "writeFileAtomicQueued",
    owners: [
      "apps/desktop/electron/persistence/atomic-file-write.ts",
      "apps/desktop/electron/persistence/app-store-persistence.ts",
      "apps/desktop/electron/persistence/attachment-store.ts",
      "apps/desktop/electron/scheduled-tasks/scheduled-task-store.ts",
      reviewedStore,
      checkpointStore,
    ],
  },
];
const productSourceRoots = [
  "apps/desktop/electron",
  "apps/desktop/src",
  "apps/desktop/contracts",
  ...readdirSync(path.join(root, "packages")).map((name) => `packages/${name}/src`),
];

function sourceFiles(directory) {
  if (!existsSync(path.join(root, directory))) return [];
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)
      ? [relative]
      : [];
  });
}

function durableStateViolations(filePath, source) {
  return durableStateOwners
    .filter(({ token, owners }) => !owners.includes(filePath) && token.test(source))
    .map(({ name }) => `${filePath}: uses ${name} outside its owner module`);
}

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

test("the state-owner guard rejects durable review and checkpoint state outside its owners", () => {
  assert.deepEqual(
    durableStateViolations(
      "apps/desktop/electron/workbench/review-owner.ts",
      `import { writeFileAtomicQueued } from "../persistence/atomic-file-write";
       const marks = join(userData, "reviewed-files.json");
       const objects = join(userData, "turn-checkpoints", "objects.git");`,
    ),
    [
      "apps/desktop/electron/workbench/review-owner.ts: uses reviewed-files.json outside its owner module",
      "apps/desktop/electron/workbench/review-owner.ts: uses the checkpoint store paths outside its owner module",
      "apps/desktop/electron/workbench/review-owner.ts: uses writeFileAtomicQueued outside its owner module",
    ],
  );
  assert.deepEqual(
    durableStateViolations(checkpointStore, 'join(directory, "checkpoints.json")'),
    [],
  );
});

test("reviewed marks, checkpoint storage and atomic writes stay in their owner modules", () => {
  const violations = productSourceRoots
    .flatMap(sourceFiles)
    .flatMap((filePath) =>
      durableStateViolations(filePath, readFileSync(path.join(root, filePath), "utf8")),
    );
  assert.deepEqual(violations, []);
  for (const { owners } of durableStateOwners) {
    for (const owner of owners) assert.ok(existsSync(path.join(root, owner)), `${owner} exists`);
  }
});
