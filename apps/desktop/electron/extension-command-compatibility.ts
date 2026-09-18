import type { RuntimeCommandRecord, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { ExtensionCommandCompatibilityRecord } from "../src/desktop-state";

export interface PendingRuntimeCommandExecution {
  readonly command: RuntimeCommandRecord;
  blockedMessage?: string;
}

export function createCompatibilityKey(extensionPath: string, commandName: string): string {
  return `${extensionPath}::${commandName}`;
}

export function createCompatibilityKeyForCommand(command: RuntimeCommandRecord): string {
  return createCompatibilityKey(command.sourceInfo.path, command.name);
}

export function getLearnedCommandCompatibility(
  compatibilityByWorkspace: Map<string, Map<string, ExtensionCommandCompatibilityRecord>>,
  workspaceId: string,
  command: RuntimeCommandRecord,
): ExtensionCommandCompatibilityRecord | undefined {
  return compatibilityByWorkspace.get(workspaceId)?.get(createCompatibilityKeyForCommand(command));
}

export function recordLearnedCommandCompatibility(
  compatibilityByWorkspace: Map<string, Map<string, ExtensionCommandCompatibilityRecord>>,
  workspaceId: string,
  record: ExtensionCommandCompatibilityRecord,
): ExtensionCommandCompatibilityRecord {
  const byWorkspace =
    compatibilityByWorkspace.get(workspaceId) ??
    new Map<string, ExtensionCommandCompatibilityRecord>();
  byWorkspace.set(createCompatibilityKey(record.extensionPath, record.commandName), record);
  compatibilityByWorkspace.set(workspaceId, byWorkspace);
  return record;
}

export function serializeCompatibilityByWorkspace(
  compatibilityByWorkspace: Map<string, Map<string, ExtensionCommandCompatibilityRecord>>,
): Record<string, readonly ExtensionCommandCompatibilityRecord[]> {
  return Object.fromEntries(
    [...compatibilityByWorkspace.entries()].map(([workspaceId, records]) => [
      workspaceId,
      [...records.values()].sort(compareCompatibilityRecords),
    ]),
  );
}

export function restoreCompatibilityByWorkspace(
  payload: Record<string, readonly ExtensionCommandCompatibilityRecord[]> | undefined,
): Map<string, Map<string, ExtensionCommandCompatibilityRecord>> {
  const restored = new Map<string, Map<string, ExtensionCommandCompatibilityRecord>>();
  for (const [workspaceId, records] of Object.entries(payload ?? {})) {
    const byWorkspace = new Map<string, ExtensionCommandCompatibilityRecord>();
    for (const record of records) {
      if (!record.commandName || !record.extensionPath) {
        continue;
      }
      byWorkspace.set(createCompatibilityKey(record.extensionPath, record.commandName), record);
    }
    if (byWorkspace.size > 0) {
      restored.set(workspaceId, byWorkspace);
    }
  }
  return restored;
}

export function pruneCompatibilityForRuntimeSnapshot(
  compatibilityByWorkspace: Map<string, Map<string, ExtensionCommandCompatibilityRecord>>,
  runtime: RuntimeSnapshot | undefined,
): void {
  if (!runtime) {
    return;
  }

  const byWorkspace = compatibilityByWorkspace.get(runtime.workspace.workspaceId);
  if (!byWorkspace) {
    return;
  }

  const liveExtensions = new Map(
    runtime.extensions.map((extension) => [extension.path, extension] as const),
  );
  for (const [key, record] of [...byWorkspace.entries()]) {
    const extension = liveExtensions.get(record.extensionPath);
    if (!extension) {
      byWorkspace.delete(key);
      continue;
    }

    const baseCommandName = record.commandName.split(":")[0] ?? record.commandName;
    if (!extension.commands.includes(baseCommandName)) {
      byWorkspace.delete(key);
    }
  }

  if (byWorkspace.size === 0) {
    compatibilityByWorkspace.delete(runtime.workspace.workspaceId);
  }
}

function compareCompatibilityRecords(
  left: ExtensionCommandCompatibilityRecord,
  right: ExtensionCommandCompatibilityRecord,
): number {
  const pathCompare = left.extensionPath.localeCompare(right.extensionPath);
  if (pathCompare !== 0) {
    return pathCompare;
  }

  return left.commandName.localeCompare(right.commandName);
}
