import type { HostUiResponse } from "@pi-gui/session-driver";
import type { NavigateSessionTreeOptions } from "@pi-gui/session-driver/types";
import type { RuntimeSettingsSnapshot } from "@pi-gui/session-driver/runtime-types";
import {
  isThemeMode,
  isThemePresetId,
  type AppView,
  type ComposerAttachment,
  type CreateSessionInput,
  type CreateWorktreeInput,
  type ForkThreadInput,
  type ModelSettingsScopeMode,
  type NotificationPreferences,
  type RemoveWorktreeInput,
  type SendChildThreadFollowUpInput,
  type SetChildSupervisionLoopInput,
  type StartThreadInput,
  type ThemeMode,
  type ThemePresetId,
  type WorkspaceSessionTarget,
} from "../../contracts/desktop-state";
import type {
  CustomProviderConfig,
  CustomProviderProbeInput,
  TerminalSize,
} from "../../contracts/ipc";
import {
  assertScheduledTaskSchedule,
  assertScheduledTaskTarget,
  type CreateScheduledTaskInput,
  type UpdateScheduledTaskInput,
} from "../../contracts/scheduled-tasks";
import { assertComposerAttachmentsAccepted } from "../../contracts/composer-attachments";

export function expectString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

export function expectNonEmptyString(value: unknown, name: string): string {
  const parsed = expectString(value, name).trim();
  if (!parsed) {
    throw new TypeError(`${name} must not be empty`);
  }
  return parsed;
}

export function expectOptionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : expectString(value, name);
}

export function expectBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
  return value;
}

function expectOptionalBoolean(value: unknown, name: string): boolean | undefined {
  return value === undefined ? undefined : expectBoolean(value, name);
}

function expectOptionalNonEmptyString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : expectNonEmptyString(value, name);
}

function expectOptionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

export function expectStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return value;
}

export function expectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function expectSessionTarget(value: unknown, name = "target"): WorkspaceSessionTarget {
  const record = expectRecord(value, name);
  return {
    workspaceId: expectNonEmptyString(record.workspaceId, `${name}.workspaceId`),
    sessionId: expectNonEmptyString(record.sessionId, `${name}.sessionId`),
  };
}

export function expectAppView(value: unknown, name = "view"): AppView {
  if (
    value !== "threads" &&
    value !== "new-thread" &&
    value !== "scheduled" &&
    value !== "skills" &&
    value !== "extensions" &&
    value !== "settings"
  ) {
    throw new TypeError(`${name} must be a supported app view`);
  }
  return value;
}

export function expectThemeMode(value: unknown, name = "mode"): ThemeMode {
  if (!isThemeMode(value)) {
    throw new TypeError(`${name} must be system, light, or dark`);
  }
  return value;
}

export function expectThemePresetId(value: unknown, name = "presetId"): ThemePresetId {
  if (!isThemePresetId(value)) {
    throw new TypeError(`${name} must be a supported theme preset`);
  }
  return value;
}

export function expectModelSettingsScopeMode(
  value: unknown,
  name = "mode",
): ModelSettingsScopeMode {
  if (value !== "app-global" && value !== "per-repo") {
    throw new TypeError(`${name} must be app-global or per-repo`);
  }
  return value;
}

export function expectThinkingLevel(
  value: unknown,
  name = "thinkingLevel",
): NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]> {
  if (
    value !== "off" &&
    value !== "minimal" &&
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "xhigh" &&
    value !== "max"
  ) {
    throw new TypeError(`${name} must be a supported thinking level`);
  }
  return value;
}

export function expectOptionalThinkingLevel(
  value: unknown,
  name = "thinkingLevel",
): RuntimeSettingsSnapshot["defaultThinkingLevel"] {
  return value === undefined ? undefined : expectThinkingLevel(value, name);
}

export function expectCreateWorktreeInput(value: unknown): CreateWorktreeInput {
  const record = expectRecord(value, "input");
  return {
    workspaceId: expectNonEmptyString(record.workspaceId, "input.workspaceId"),
    fromSessionWorkspaceId: expectOptionalNonEmptyString(
      record.fromSessionWorkspaceId,
      "input.fromSessionWorkspaceId",
    ),
    fromSessionId: expectOptionalNonEmptyString(record.fromSessionId, "input.fromSessionId"),
  };
}

export function expectRemoveWorktreeInput(value: unknown): RemoveWorktreeInput {
  const record = expectRecord(value, "input");
  return {
    workspaceId: expectNonEmptyString(record.workspaceId, "input.workspaceId"),
    worktreeId: expectNonEmptyString(record.worktreeId, "input.worktreeId"),
  };
}

export function expectCreateSessionInput(value: unknown): CreateSessionInput {
  const record = expectRecord(value, "input");
  return {
    workspaceId: expectNonEmptyString(record.workspaceId, "input.workspaceId"),
    title: expectOptionalString(record.title, "input.title"),
  };
}

export function expectStartThreadInput(value: unknown): StartThreadInput {
  const record = expectRecord(value, "input");
  const environment = record.environment;
  if (environment !== "local" && environment !== "worktree") {
    throw new TypeError("input.environment must be local or worktree");
  }
  return {
    rootWorkspaceId: expectNonEmptyString(record.rootWorkspaceId, "input.rootWorkspaceId"),
    environment,
    prompt: expectOptionalString(record.prompt, "input.prompt"),
    attachments:
      record.attachments === undefined
        ? undefined
        : expectComposerAttachments(record.attachments, "input.attachments"),
    provider: expectOptionalNonEmptyString(record.provider, "input.provider"),
    modelId: expectOptionalNonEmptyString(record.modelId, "input.modelId"),
    thinkingLevel: expectOptionalString(record.thinkingLevel, "input.thinkingLevel"),
  };
}

export function expectForkThreadInput(value: unknown): ForkThreadInput {
  const record = expectRecord(value, "input");
  const environment = record.environment;
  if (environment !== "local" && environment !== "worktree") {
    throw new TypeError("input.environment must be local or worktree");
  }
  const position = record.position;
  if (
    position !== undefined &&
    position !== "before" &&
    position !== "at" &&
    position !== "after"
  ) {
    throw new TypeError("input.position must be before, at, or after");
  }
  return {
    sourceWorkspaceId: expectNonEmptyString(record.sourceWorkspaceId, "input.sourceWorkspaceId"),
    sourceSessionId: expectNonEmptyString(record.sourceSessionId, "input.sourceSessionId"),
    rootWorkspaceId: expectNonEmptyString(record.rootWorkspaceId, "input.rootWorkspaceId"),
    environment,
    sourceMessageId: expectOptionalNonEmptyString(record.sourceMessageId, "input.sourceMessageId"),
    sourceMessageIndex: expectOptionalNonNegativeInteger(
      record.sourceMessageIndex,
      "input.sourceMessageIndex",
    ),
    userMessageIndex: expectOptionalNonNegativeInteger(
      record.userMessageIndex,
      "input.userMessageIndex",
    ),
    position,
  };
}

export function expectSendChildThreadFollowUpInput(value: unknown): SendChildThreadFollowUpInput {
  const record = expectRecord(value, "input");
  return {
    childThreadId: expectNonEmptyString(record.childThreadId, "input.childThreadId"),
    text: expectString(record.text, "input.text"),
  };
}

export function expectSetChildSupervisionLoopInput(value: unknown): SetChildSupervisionLoopInput {
  const record = expectRecord(value, "input");
  if (record.gate !== "continue" && record.gate !== "stop") {
    throw new TypeError("input.gate must be continue or stop");
  }
  return {
    childThreadId: expectNonEmptyString(record.childThreadId, "input.childThreadId"),
    gate: record.gate,
  };
}

export function expectNotificationPreferences(value: unknown): Partial<NotificationPreferences> {
  const record = expectRecord(value, "preferences");
  let preferences: Partial<NotificationPreferences> = {};
  for (const key of ["backgroundCompletion", "backgroundFailure", "attentionNeeded"] as const) {
    if (Object.hasOwn(record, key)) {
      preferences = { ...preferences, [key]: expectBoolean(record[key], `preferences.${key}`) };
    }
  }
  return preferences;
}

export function expectCustomProviderConfig(value: unknown): CustomProviderConfig {
  const record = expectRecord(value, "config");
  if (!Array.isArray(record.models)) {
    throw new TypeError("config.models must be an array");
  }
  return {
    providerId: expectNonEmptyString(record.providerId, "config.providerId"),
    baseUrl: expectNonEmptyString(record.baseUrl, "config.baseUrl"),
    apiKey: expectOptionalString(record.apiKey, "config.apiKey"),
    models: record.models.map((model, index) => {
      const entry = expectRecord(model, `config.models[${index}]`);
      const contextWindow = entry.contextWindow;
      if (
        contextWindow !== undefined &&
        (typeof contextWindow !== "number" ||
          !Number.isSafeInteger(contextWindow) ||
          contextWindow <= 0)
      ) {
        throw new TypeError(`config.models[${index}].contextWindow must be a positive integer`);
      }
      return {
        id: expectNonEmptyString(entry.id, `config.models[${index}].id`),
        contextWindow,
      };
    }),
  };
}

export function expectCustomProviderProbeInput(value: unknown): CustomProviderProbeInput {
  const record = expectRecord(value, "input");
  return {
    baseUrl: expectNonEmptyString(record.baseUrl, "input.baseUrl"),
    apiKey: expectOptionalString(record.apiKey, "input.apiKey"),
  };
}

export function expectHostUiResponse(value: unknown): HostUiResponse {
  const record = expectRecord(value, "response");
  const requestId = expectNonEmptyString(record.requestId, "response.requestId");
  const variants = [
    typeof record.value === "string",
    typeof record.confirmed === "boolean",
    record.cancelled === true,
  ].filter(Boolean).length;
  if (variants !== 1) {
    throw new TypeError("response must contain exactly one of value, confirmed, or cancelled");
  }
  if (typeof record.value === "string") {
    return { requestId, value: record.value };
  }
  if (typeof record.confirmed === "boolean") {
    return { requestId, confirmed: record.confirmed };
  }
  return { requestId, cancelled: true };
}

export function expectNavigateSessionTreeOptions(value: unknown): NavigateSessionTreeOptions {
  const record = expectRecord(value, "options");
  return {
    summarize: expectOptionalBoolean(record.summarize, "options.summarize"),
    customInstructions: expectOptionalString(
      record.customInstructions,
      "options.customInstructions",
    ),
  };
}

export function expectTerminalSize(value: unknown, name = "size"): TerminalSize {
  const record = expectRecord(value, name);
  const cols = record.cols;
  const rows = record.rows;
  if (typeof cols !== "number" || !Number.isSafeInteger(cols) || cols <= 0) {
    throw new TypeError(`${name}.cols must be a positive integer`);
  }
  if (typeof rows !== "number" || !Number.isSafeInteger(rows) || rows <= 0) {
    throw new TypeError(`${name}.rows must be a positive integer`);
  }
  return { cols, rows };
}

export function expectWorkspaceFileListOptions(
  value: unknown,
): { readonly force?: boolean } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = expectRecord(value, "options");
  return { force: expectOptionalBoolean(record.force, "options.force") };
}

export function expectComposerAttachments(
  value: unknown,
  name = "attachments",
): readonly ComposerAttachment[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`);
  }
  const attachments = value.map((attachment, index) => {
    const itemName = `${name}[${index}]`;
    const record = expectRecord(attachment, itemName);
    const common = {
      id: expectNonEmptyString(record.id, `${itemName}.id`),
      name: expectNonEmptyString(record.name, `${itemName}.name`),
      mimeType: expectNonEmptyString(record.mimeType, `${itemName}.mimeType`),
    };
    if (record.kind === "image") {
      return {
        ...common,
        kind: "image" as const,
        data: expectNonEmptyString(record.data, `${itemName}.data`),
      };
    }
    if (record.kind === "file") {
      const sizeBytes = expectOptionalNonNegativeInteger(record.sizeBytes, `${itemName}.sizeBytes`);
      return {
        ...common,
        kind: "file" as const,
        fsPath: expectNonEmptyString(record.fsPath, `${itemName}.fsPath`),
        sizeBytes,
      };
    }
    throw new TypeError(`${itemName}.kind must be image or file`);
  });
  return assertComposerAttachmentsAccepted([], attachments);
}

export function expectOptionalDeliverOptions(
  value: unknown,
): { readonly deliverAs?: "steer" | "followUp" } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = expectRecord(value, "options");
  if (record.deliverAs === undefined) {
    return {};
  }
  if (record.deliverAs !== "steer" && record.deliverAs !== "followUp") {
    throw new TypeError("options.deliverAs must be steer or followUp");
  }
  return { deliverAs: record.deliverAs };
}

export function expectCreateScheduledTaskInput(value: unknown): CreateScheduledTaskInput {
  const record = expectRecord(value, "input");
  return {
    title: expectNonEmptyString(record.title, "input.title"),
    instruction: expectNonEmptyString(record.instruction, "input.instruction"),
    schedule: assertScheduledTaskSchedule(record.schedule, "input.schedule"),
    target: assertScheduledTaskTarget(record.target, "input.target"),
    originSessionId: expectOptionalNonEmptyString(record.originSessionId, "input.originSessionId"),
  };
}

export function expectUpdateScheduledTaskInput(value: unknown): UpdateScheduledTaskInput {
  const record = expectRecord(value, "patch");
  const status = record.status;
  if (
    status !== undefined &&
    status !== "active" &&
    status !== "paused" &&
    status !== "completed"
  ) {
    throw new TypeError("patch.status must be active, paused, or completed");
  }
  return {
    title: expectOptionalNonEmptyString(record.title, "patch.title"),
    instruction: expectOptionalNonEmptyString(record.instruction, "patch.instruction"),
    ...(record.schedule === undefined
      ? {}
      : { schedule: assertScheduledTaskSchedule(record.schedule, "patch.schedule") }),
    ...(record.target === undefined
      ? {}
      : { target: assertScheduledTaskTarget(record.target, "patch.target") }),
    ...(status ? { status } : {}),
  };
}
