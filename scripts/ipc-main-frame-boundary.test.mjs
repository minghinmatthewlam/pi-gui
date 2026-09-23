import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const electronDir = "apps/desktop/electron";
const helper = `${electronDir}/ipc/main-frame-ipc.ts`;

// Modules that may use ipcMain directly, and why.
const rawIpcAllowlist = new Map([
  [helper, "the main-frame helper itself"],
  [
    `${electronDir}/ipc/register-desktop-ipc.ts`,
    "the pre-existing app-wide handlers (state, conversation, workspace, settings, terminal) " +
      "resolve the sender window but do not gate on the frame; subframes receive no preload. " +
      "Migrating them is a separate change; the channels below must not regress to raw handlers.",
  ],
]);

// Channels whose handlers must reject anything other than the owned window's main frame.
const mainFrameChannels = [
  "resolveTurnReview",
  "getReview",
  "getReviewFile",
  "setReviewFileReviewed",
  "changeReviewFileStage",
  "listExtensionViews",
  "openExtensionView",
  "sendExtensionViewMessage",
  "closeExtensionView",
  "getTaskWorkbenchTemplate",
  "saveTaskWorkbenchTemplate",
  "persistComposerDraft",
];

function ipcViolations(filePath, source) {
  const violations = [];
  const allowed = rawIpcAllowlist.has(filePath);
  if (!allowed && /\bipcMain\b/.test(source)) {
    violations.push(`${filePath}: registers IPC without the main-frame helper`);
  }
  if (filePath !== helper && /\bsenderFrame\b/.test(source)) {
    violations.push(`${filePath}: hand-copies a sender-frame check; use mainFrameHandler`);
  }
  if (allowed && filePath !== helper) {
    for (const match of source.matchAll(/\bipcMain\.\w+\(\s*desktopIpc\.(\w+)/g)) {
      if (mainFrameChannels.includes(match[1])) {
        violations.push(`${filePath}: ${match[1]} must be registered through mainFrameHandler`);
      }
    }
  }
  return violations;
}

function sourceFiles(directory) {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.[cm]?tsx?$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name) ? [relative] : [];
  });
}

test("the IPC guard rejects raw handlers and hand-copied frame checks", () => {
  assert.deepEqual(
    ipcViolations(
      `${electronDir}/ipc/new-requests.ts`,
      `import { ipcMain } from "electron";
       ipcMain.handle("x", (event) => { if (event.senderFrame !== main) throw 0; });`,
    ),
    [
      `${electronDir}/ipc/new-requests.ts: registers IPC without the main-frame helper`,
      `${electronDir}/ipc/new-requests.ts: hand-copies a sender-frame check; use mainFrameHandler`,
    ],
  );
  assert.deepEqual(
    ipcViolations(
      `${electronDir}/ipc/register-desktop-ipc.ts`,
      `ipcMain.handle(desktopIpc.getReview, (event, raw) => owner.getReview(raw));
       ipcMain.handle(desktopIpc.getState, (event) => state(event));`,
    ),
    [
      `${electronDir}/ipc/register-desktop-ipc.ts: getReview must be registered through mainFrameHandler`,
    ],
  );
});

test("main-frame IPC is registered only through the helper", () => {
  const violations = sourceFiles(electronDir).flatMap((filePath) =>
    ipcViolations(filePath, readFileSync(path.join(root, filePath), "utf8")),
  );
  assert.deepEqual(violations, []);
  const helperSource = readFileSync(path.join(root, helper), "utf8");
  assert.match(helperSource, /!event\.senderFrame \|\| event\.senderFrame !== contents\.mainFrame/);
  const contracts = readFileSync(path.join(root, "apps/desktop/contracts/ipc.ts"), "utf8");
  for (const channel of mainFrameChannels) {
    assert.match(contracts, new RegExp(`\\b${channel}:`), `${channel} is a desktop IPC channel`);
  }
});
