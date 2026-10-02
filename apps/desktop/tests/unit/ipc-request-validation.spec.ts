import { expect, test } from "@playwright/test";
import {
  expectAppView,
  expectCreateScheduledTaskInput,
  expectCustomProviderConfig,
  expectForkThreadInput,
  expectHostUiResponse,
  expectMcpServerScope,
  expectModelSettingsScopeMode,
  expectNewMcpServerInput,
  expectNotificationPreferences,
  expectOptionalDeliverOptions,
  expectSessionTarget,
  expectSetChildSupervisionLoopInput,
  expectStartThreadInput,
  expectStringArray,
  expectTerminalSize,
  expectThemeMode,
  expectThemePresetId,
  expectThinkingLevel,
} from "../../electron/ipc/request-validation";

test("IPC request validation returns a fresh trusted session target", () => {
  const request = { workspaceId: " workspace-a ", sessionId: " session-a " };

  const target = expectSessionTarget(request);

  expect(target).toEqual({ workspaceId: "workspace-a", sessionId: "session-a" });
  expect(target).not.toBe(request);
});

test("IPC request validation rejects malformed targets and string lists", () => {
  expect(() => expectSessionTarget({ workspaceId: "workspace-a" })).toThrow(
    "target.sessionId must be a string",
  );
  expect(() => expectSessionTarget({ workspaceId: "", sessionId: "session-a" })).toThrow(
    "target.workspaceId must not be empty",
  );
  expect(() => expectStringArray(["safe", 4], "order")).toThrow(
    "order must be an array of strings",
  );
});

test("IPC request validation allowlists composer delivery modes", () => {
  expect(expectOptionalDeliverOptions(undefined)).toBeUndefined();
  expect(expectOptionalDeliverOptions({ deliverAs: "steer" })).toEqual({ deliverAs: "steer" });
  expect(expectOptionalDeliverOptions({ deliverAs: "followUp" })).toEqual({
    deliverAs: "followUp",
  });
  expect(() => expectOptionalDeliverOptions({ deliverAs: "immediate" })).toThrow(
    "options.deliverAs must be steer or followUp",
  );
});

test("IPC request validation rejects unknown enum values", () => {
  expect(expectAppView("new-thread")).toBe("new-thread");
  expect(expectAppView("scheduled")).toBe("scheduled");
  expect(expectThemeMode("dark")).toBe("dark");
  expect(expectThemePresetId("tokyo-night")).toBe("tokyo-night");
  expect(expectModelSettingsScopeMode("per-repo")).toBe("per-repo");
  expect(expectThinkingLevel("xhigh")).toBe("xhigh");

  expect(() => expectAppView("terminal")).toThrow("view must be a supported app view");
  expect(() => expectThemeMode("auto")).toThrow("mode must be system, light, or dark");
  expect(() => expectThemePresetId("solarized")).toThrow(
    "presetId must be a supported theme preset",
  );
  expect(() => expectModelSettingsScopeMode("workspace")).toThrow(
    "mode must be app-global or per-repo",
  );
  expect(() => expectThinkingLevel("ultra")).toThrow(
    "thinkingLevel must be a supported thinking level",
  );
});

test("IPC request validation decodes persisted settings records", () => {
  expect(
    expectNotificationPreferences({
      backgroundCompletion: true,
      backgroundFailure: false,
      attentionNeeded: true,
    }),
  ).toEqual({
    backgroundCompletion: true,
    backgroundFailure: false,
    attentionNeeded: true,
  });
  expect(() =>
    expectNotificationPreferences({
      backgroundCompletion: "yes",
      backgroundFailure: false,
      attentionNeeded: true,
    }),
  ).toThrow("preferences.backgroundCompletion must be a boolean");

  expect(
    expectCustomProviderConfig({
      providerId: "local",
      baseUrl: "http://localhost:8080",
      models: [{ id: "model-a", contextWindow: 32_000 }],
    }),
  ).toEqual({
    providerId: "local",
    baseUrl: "http://localhost:8080",
    apiKey: undefined,
    models: [{ id: "model-a", contextWindow: 32_000 }],
  });
  expect(() =>
    expectCustomProviderConfig({
      providerId: "local",
      baseUrl: "http://localhost:8080",
      models: [{ id: "model-a", contextWindow: -1 }],
    }),
  ).toThrow("config.models[0].contextWindow must be a positive integer");
});

test("IPC request validation checks discriminated command records", () => {
  expect(expectHostUiResponse({ requestId: "request-a", confirmed: false })).toEqual({
    requestId: "request-a",
    confirmed: false,
  });
  expect(() =>
    expectHostUiResponse({ requestId: "request-a", confirmed: true, cancelled: true }),
  ).toThrow("response must contain exactly one of value, confirmed, or cancelled");

  expect(
    expectForkThreadInput({
      sourceWorkspaceId: "workspace-a",
      sourceSessionId: "session-a",
      rootWorkspaceId: "workspace-a",
      environment: "local",
      position: "after",
      sourceMessageIndex: 3,
    }),
  ).toMatchObject({ environment: "local", position: "after", sourceMessageIndex: 3 });
  expect(() =>
    expectForkThreadInput({
      sourceWorkspaceId: "workspace-a",
      sourceSessionId: "session-a",
      rootWorkspaceId: "workspace-a",
      environment: "cloud",
    }),
  ).toThrow("input.environment must be local or worktree");

  expect(() =>
    expectSetChildSupervisionLoopInput({ childThreadId: "child-a", gate: "wake" }),
  ).toThrow("input.gate must be continue or stop");
  expect(() => expectTerminalSize({ cols: 0, rows: 24 })).toThrow(
    "size.cols must be a positive integer",
  );
});

test("notification checkbox patches validate only provided fields", () => {
  for (const key of ["backgroundCompletion", "backgroundFailure", "attentionNeeded"] as const) {
    expect(expectNotificationPreferences({ [key]: false })).toEqual({ [key]: false });
    expect(() => expectNotificationPreferences({ [key]: "false" })).toThrow(
      `preferences.${key} must be a boolean`,
    );
    expect(() => expectNotificationPreferences({ [key]: undefined })).toThrow(
      `preferences.${key} must be a boolean`,
    );
  }
  expect(expectNotificationPreferences({})).toEqual({});
});

test("IPC request validation rejects malformed scheduled tasks", () => {
  const target = { kind: "new-thread", workspaceId: "ws" };
  expect(() =>
    expectCreateScheduledTaskInput({
      title: "",
      instruction: "do it",
      schedule: { kind: "once", at: "2026-09-21T12:00:00.000Z" },
      target,
    }),
  ).toThrow("input.title must not be empty");
  expect(() =>
    expectCreateScheduledTaskInput({
      title: "Ping",
      instruction: "   ",
      schedule: { kind: "once", at: "2026-09-21T12:00:00.000Z" },
      target,
    }),
  ).toThrow("input.instruction must not be empty");
  expect(() =>
    expectCreateScheduledTaskInput({
      title: "Ping",
      instruction: "do it",
      schedule: { kind: "interval", everyMs: 1_000 },
      target,
    }),
  ).toThrow(/everyMs/);
  expect(() =>
    expectCreateScheduledTaskInput({
      title: "Ping",
      instruction: "do it",
      schedule: { kind: "weekly", days: [], hour: 9, minute: 0, timeZone: "UTC" },
      target,
    }),
  ).toThrow(/days/);
  expect(() =>
    expectCreateScheduledTaskInput({
      title: "Ping",
      instruction: "do it",
      schedule: { kind: "daily", hour: 9, minute: 0, timeZone: "Not/A_Zone" },
      target,
    }),
  ).toThrow(/timeZone/);
});

test("IPC request validation passes new-thread extension flags through as booleans and strings", () => {
  const base = { rootWorkspaceId: "workspace-a", environment: "local" };

  expect(expectStartThreadInput(base).extensionFlags).toBeUndefined();
  expect(
    expectStartThreadInput({
      ...base,
      extensionFlags: { plan: true, "dry-run": false, env: "staging", preset: "" },
    }).extensionFlags,
  ).toEqual({ plan: true, "dry-run": false, env: "staging", preset: "" });

  expect(() => expectStartThreadInput({ ...base, extensionFlags: ["plan"] })).toThrow(
    "input.extensionFlags must be an object",
  );
  expect(() => expectStartThreadInput({ ...base, extensionFlags: { retries: 3 } })).toThrow(
    "input.extensionFlags.retries must be a boolean or string",
  );
  expect(() => expectStartThreadInput({ ...base, extensionFlags: { plan: null } })).toThrow(
    "input.extensionFlags.plan must be a boolean or string",
  );
  expect(() => expectStartThreadInput({ ...base, extensionFlags: { " ": true } })).toThrow(
    "flag names must be non-empty",
  );
});

test("IPC request validation accepts one MCP server shape and a known scope", () => {
  expect(expectNewMcpServerInput({ name: " docs ", command: "npx", args: ["-y", "a b"] })).toEqual({
    name: "docs",
    command: "npx",
    args: ["-y", "a b"],
  });
  expect(expectNewMcpServerInput({ name: "docs", command: "npx" })).toEqual({
    name: "docs",
    command: "npx",
    args: [],
  });
  expect(expectNewMcpServerInput({ name: "docs", url: "https://example.com/mcp" })).toEqual({
    name: "docs",
    url: "https://example.com/mcp",
  });
  expect(() =>
    expectNewMcpServerInput({ name: "docs", url: "https://example.com/mcp", command: "npx" }),
  ).toThrow("either a url or a command");
  expect(() => expectNewMcpServerInput({ name: "", command: "npx" })).toThrow(
    "server.name must not be empty",
  );
  expect(() => expectNewMcpServerInput({ name: "docs", command: "npx", args: [1] })).toThrow(
    "server.args must be an array of strings",
  );
  for (const name of ["my docs", "docs.v2", "docs/api", "dócs"]) {
    expect(() => expectNewMcpServerInput({ name, command: "npx" })).toThrow(
      'server.name may only use letters, digits, "_" and "-"',
    );
  }
  expect(expectNewMcpServerInput({ name: "Docs_v2-beta", command: "npx" }).name).toBe(
    "Docs_v2-beta",
  );
  expect(expectMcpServerScope("project")).toBe("project");
  expect(() => expectMcpServerScope("extension")).toThrow("scope must be global or project");
});
