/** Private Pi 0.80 hooks needed to persist project-scoped settings. */
interface ProjectWritablePiSettingsManager {
  markProjectModified(field: string, nestedKey?: string): void;
  saveProjectSettings(settings: Record<string, unknown>): void;
}

export function savePiProjectSettings(
  settingsManager: object,
  projectSettings: Record<string, unknown>,
  modifiedFields: readonly string[],
): void {
  const compatibleManager = settingsManager as Partial<ProjectWritablePiSettingsManager>;
  if (
    typeof compatibleManager.markProjectModified !== "function" ||
    typeof compatibleManager.saveProjectSettings !== "function"
  ) {
    throw new Error("The bundled Pi runtime does not support project-scoped settings persistence.");
  }

  for (const field of modifiedFields) {
    compatibleManager.markProjectModified.call(settingsManager, field);
  }
  compatibleManager.saveProjectSettings.call(settingsManager, projectSettings);
}
