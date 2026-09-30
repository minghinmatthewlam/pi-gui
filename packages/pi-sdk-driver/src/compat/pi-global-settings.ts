/**
 * Private Pi 0.99 hooks needed to persist a global setting that has no public setter.
 * `getGlobalSettings()` returns a copy, so the change goes into the manager's own
 * `globalSettings`, then `markModified` + `save` write only that field back to disk.
 */
interface GlobalWritablePiSettingsManager {
  globalSettings: Record<string, unknown>;
  markModified(field: string, nestedKey?: string): void;
  save(): void;
}

export function savePiGlobalSetting(settingsManager: object, field: string, value: unknown): void {
  const compatibleManager = settingsManager as Partial<GlobalWritablePiSettingsManager>;
  if (
    typeof compatibleManager.globalSettings !== "object" ||
    compatibleManager.globalSettings === null ||
    typeof compatibleManager.markModified !== "function" ||
    typeof compatibleManager.save !== "function"
  ) {
    throw new Error("The bundled Pi runtime does not support saving this global setting.");
  }

  if (value === undefined) {
    delete compatibleManager.globalSettings[field];
  } else {
    compatibleManager.globalSettings[field] = value;
  }
  compatibleManager.markModified.call(settingsManager, field);
  compatibleManager.save.call(settingsManager);
}
