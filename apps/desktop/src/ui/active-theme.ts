import { useSyncExternalStore } from "react";
import { isThemePresetId, type ThemePresetId } from "../../contracts/desktop-state";
import {
  themePreset,
  themeTokensFor,
  type ResolvedTheme,
  type SyntaxThemeId,
  type ThemeTokens,
} from "../../contracts/theme";

/*
 * The one place the renderer's theme is applied. `applyTheme` writes every
 * derived token as a CSS variable; components that cannot read CSS (the
 * terminal, the syntax highlighter, extension views) subscribe with
 * `useActiveTheme`.
 */

export interface ActiveTheme {
  readonly presetId: ThemePresetId;
  readonly variant: ResolvedTheme;
  readonly tokens: ThemeTokens;
  readonly syntaxTheme: SyntaxThemeId;
}

const STYLE_ELEMENT_ID = "pi-theme";
// Remembers the last theme so the next launch paints it before state loads.
const LAST_THEME_KEY = "pi-gui.last-theme";

let active: ActiveTheme = createActiveTheme("default", "light");
const listeners = new Set<() => void>();

export function applyTheme(presetId: ThemePresetId, variant: ResolvedTheme): void {
  if (active.presetId !== presetId || active.variant !== variant || !styleElement()) {
    active = createActiveTheme(presetId, variant);
    writeTokens(active);
    for (const listener of listeners) listener();
  }
  try {
    localStorage.setItem(LAST_THEME_KEY, `${presetId}:${variant}`);
  } catch {
    // Storage can be unavailable; the next launch then starts from Default.
  }
}

/** Applies the theme saved by the previous launch, or Default light. */
export function applyLastTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LAST_THEME_KEY);
  } catch {
    saved = null;
  }
  const [presetId, variant] = saved?.split(":") ?? [];
  applyTheme(
    isThemePresetId(presetId) ? presetId : "default",
    variant === "dark" ? "dark" : "light",
  );
}

export function useActiveTheme(): ActiveTheme {
  return useSyncExternalStore(subscribe, getActiveTheme);
}

export function getActiveTheme(): ActiveTheme {
  return active;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function createActiveTheme(presetId: ThemePresetId, variant: ResolvedTheme): ActiveTheme {
  return {
    presetId,
    variant,
    tokens: themeTokensFor(presetId, variant),
    syntaxTheme: themePreset(presetId).variants[variant].syntaxTheme,
  };
}

function styleElement(): HTMLStyleElement | null {
  return document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
}

function writeTokens(theme: ActiveTheme): void {
  const root = document.documentElement;
  let element = styleElement();
  if (!element) {
    element = document.createElement("style");
    element.id = STYLE_ELEMENT_ID;
    document.head.append(element);
  }
  const declarations = Object.entries(theme.tokens)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  element.textContent = `:root {\n  color-scheme: ${theme.variant};\n${declarations}\n}\n`;
  root.classList.toggle("dark", theme.variant === "dark");
  root.dataset.themePreset = theme.presetId;
}
