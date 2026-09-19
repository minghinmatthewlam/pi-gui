const STORAGE_KEY = "pi-gui:prompt-rail-visible:v1";

export function loadPromptRailVisible(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    // Default to visible: only an explicit opt-out hides the rail.
    return raw !== "false";
  } catch {
    return true;
  }
}

export function savePromptRailVisible(visible: boolean): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, visible ? "true" : "false");
  } catch {
    // localStorage unavailable; skip persistence
  }
}
