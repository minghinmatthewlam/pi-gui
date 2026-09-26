import type { ThemePresetId } from "./desktop-state";

/*
 * Theme engine. A theme is a small seed per light/dark variant; every colour
 * token the app reads is derived from it by `deriveThemeTokens`, so all presets
 * share one design and only the palette changes (the Codex model).
 *
 * Pure and browser-safe: the renderer writes the tokens as CSS variables and
 * Electron main uses them for the native window background.
 */

export type ResolvedTheme = "light" | "dark";

export interface ThemeSeed {
  /** Main content background (the theme's editor background). */
  readonly surface: string;
  /** Strongest foreground (the theme's editor foreground). */
  readonly ink: string;
  /** Links, focus, selection rails. Never used for large fills. */
  readonly accent: string;
  readonly added: string;
  readonly removed: string;
  readonly warning: string;
}

/** Shiki theme ids (bundled or shipped in `src/ui/syntax-themes`). */
export const syntaxThemeIds = [
  "github-light-default",
  "github-dark-default",
  "catppuccin-latte",
  "catppuccin-mocha",
  "tokyo-night-light",
  "tokyo-night",
  "nord-light",
  "nord",
  "dracula-light",
  "dracula",
  "gruvbox-light-medium",
  "gruvbox-dark-medium",
  "light-plus",
  "dark-plus",
] as const;
export type SyntaxThemeId = (typeof syntaxThemeIds)[number];

interface ThemeVariant {
  readonly seed: ThemeSeed;
  readonly syntaxTheme: SyntaxThemeId;
}

export interface ThemePreset {
  readonly id: ThemePresetId;
  readonly name: string;
  readonly description: string;
  readonly variants: Readonly<Record<ResolvedTheme, ThemeVariant>>;
}

// Seed values come from each theme's own palette file (editor background and
// foreground, focus/link colour, git decoration colours).
export const themePresets: readonly ThemePreset[] = [
  {
    id: "default",
    name: "Default",
    description: "The pi-gui palette.",
    variants: {
      light: {
        seed: seed("#ffffff", "#282825", "#526795", "#2ea043", "#c45666", "#d97706"),
        syntaxTheme: "github-light-default",
      },
      dark: {
        seed: seed("#1d1d1c", "#eeeeea", "#9aaed8", "#40c977", "#e05467", "#d97706"),
        syntaxTheme: "github-dark-default",
      },
    },
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    description: "Soft pastel Latte and Mocha variants.",
    variants: {
      light: {
        seed: seed("#eff1f5", "#4c4f69", "#8839ef", "#40a02b", "#d20f39", "#df8e1d"),
        syntaxTheme: "catppuccin-latte",
      },
      dark: {
        seed: seed("#1e1e2e", "#cdd6f4", "#cba6f7", "#a6e3a1", "#f38ba8", "#f9e2af"),
        syntaxTheme: "catppuccin-mocha",
      },
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    description: "A cool editor palette with a bright Day variant.",
    variants: {
      light: {
        seed: seed("#d5d6db", "#343b58", "#34548a", "#485e30", "#8c4351", "#8f5e15"),
        syntaxTheme: "tokyo-night-light",
      },
      dark: {
        seed: seed("#1a1b26", "#c0caf5", "#7aa2f7", "#9ece6a", "#f7768e", "#e0af68"),
        syntaxTheme: "tokyo-night",
      },
    },
  },
  {
    id: "nord",
    name: "Nord",
    description: "Low-contrast arctic neutrals and blue accents.",
    variants: {
      light: {
        seed: seed("#eceff4", "#2e3440", "#5e81ac", "#5d7f45", "#bf616a", "#b0802a"),
        syntaxTheme: "nord-light",
      },
      dark: {
        seed: seed("#2e3440", "#eceff4", "#88c0d0", "#a3be8c", "#bf616a", "#ebcb8b"),
        syntaxTheme: "nord",
      },
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    description: "Dracula and its official Alucard light variant.",
    variants: {
      light: {
        seed: seed("#fffbeb", "#1f1f1f", "#644ac9", "#14710a", "#cb3a2a", "#a34d14"),
        syntaxTheme: "dracula-light",
      },
      dark: {
        seed: seed("#282a36", "#f8f8f2", "#bd93f9", "#50fa7b", "#ff5555", "#ffb86c"),
        syntaxTheme: "dracula",
      },
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    description: "Warm retro contrast.",
    variants: {
      light: {
        seed: seed("#fbf1c7", "#3c3836", "#458588", "#79740e", "#9d0006", "#b57614"),
        syntaxTheme: "gruvbox-light-medium",
      },
      dark: {
        seed: seed("#282828", "#ebdbb2", "#83a598", "#b8bb26", "#fb4934", "#fabd2f"),
        syntaxTheme: "gruvbox-dark-medium",
      },
    },
  },
  {
    id: "github",
    name: "GitHub",
    description: "GitHub-style light and dark surfaces.",
    variants: {
      light: {
        seed: seed("#ffffff", "#1f2328", "#0969da", "#1a7f37", "#cf222e", "#9a6700"),
        syntaxTheme: "github-light-default",
      },
      dark: {
        seed: seed("#0d1117", "#e6edf3", "#4493f8", "#3fb950", "#f85149", "#d29922"),
        syntaxTheme: "github-dark-default",
      },
    },
  },
  {
    id: "vscode",
    name: "VS Code",
    description: "Familiar editor colours with blue accents.",
    variants: {
      light: {
        seed: seed("#ffffff", "#1f1f1f", "#007acc", "#587c0c", "#ad0707", "#bf8803"),
        syntaxTheme: "light-plus",
      },
      dark: {
        seed: seed("#1e1e1e", "#d4d4d4", "#3794ff", "#81b88b", "#f14c4c", "#cca700"),
        syntaxTheme: "dark-plus",
      },
    },
  },
];

export function themePreset(presetId: ThemePresetId): ThemePreset {
  return themePresets.find((preset) => preset.id === presetId) ?? themePresets[0]!;
}

/** Every colour token the CSS reads, derived from one seed. */
export type ThemeTokens = Readonly<Record<`--${string}`, string>>;

export function deriveThemeTokens(seedValue: ThemeSeed, variant: ResolvedTheme): ThemeTokens {
  const light = variant === "light";
  const { surface: s, ink } = seedValue;
  // Status and accent colours also draw text and glyphs (diff letters, warnings),
  // so pale seeds (Catppuccin Latte's yellow) are deepened toward the ink until
  // they read at 3:1 on the main surface.
  const [accent, added, removed, warning] = [
    seedValue.accent,
    seedValue.added,
    seedValue.removed,
    seedValue.warning,
  ].map((color) => deepenForContrast(color, ink, s, 3)) as [string, string, string, string];
  const pick = (lightValue: number, darkValue: number): number => (light ? lightValue : darkValue);
  // Text greys are the ink faded toward the surface; lines and fills are the
  // surface tinted toward the ink. Dark "under" surfaces sink toward black.
  // Low-contrast palettes (Catppuccin Latte, Tokyo Day) fade less, so every
  // grey keeps `minContrast` against the sidebar, the darkest place text sits.
  const fade = (lightAmount: number, darkAmount: number, minContrast: number): string =>
    fadeWithContrast(ink, s, pick(lightAmount, darkAmount), minContrast, sidebar);
  const tint = (lightAmount: number, darkAmount: number): string =>
    mix(s, ink, pick(lightAmount, darkAmount));
  const sidebar = light ? tint(0.04, 0) : mix(s, "#000000", 0.17);

  const window = light ? tint(0.07, 0) : mix(s, "#000000", 0.28);
  const main = s;
  const elevated = light ? mix(s, "#ffffff", 0.4) : tint(0, 0.025);
  const surfaceMuted = tint(0.04, 0.055);
  const line = tint(0.12, 0.11);
  const lineStrong = tint(0.19, 0.21);
  const text = fade(0.1, 0.13, 7);
  const muted = fade(0.35, 0.37, 4.5);
  const mutedSoft = fade(0.41, 0.42, 4);
  const shadow = light ? ink : "#000000";
  const warningInk = mix(warning, ink, pick(0.3, 0.35));

  return {
    "--window": window,
    "--window-glass": alpha(window, 0.6),
    "--sidebar": sidebar,
    "--sidebar-glass": alpha(sidebar, 0.7),
    "--main": main,
    "--main-glass": alpha(main, 0.6),
    "--surface": elevated,
    "--surface-glass": alpha(elevated, 0.8),
    "--surface-muted": surfaceMuted,
    "--surface-muted-glass": alpha(surfaceMuted, 0.7),
    "--line": line,
    "--line-glass": alpha(line, 0.4),
    "--line-strong": lineStrong,
    "--line-strong-glass": alpha(lineStrong, 0.6),
    "--text": text,
    "--text-strong": ink,
    "--muted": muted,
    "--muted-strong": fade(0.24, 0.26, 5.5),
    "--muted-soft": mutedSoft,
    "--muted-subtle": fade(0.48, 0.56, 3),
    "--muted-icon": fade(0.38, 0.42, 3.5),
    "--muted-path": mutedSoft,
    "--muted-settings": muted,
    "--accent": accent,
    "--error": removed,
    "--error-ink": mix(removed, ink, pick(0.35, 0.3)),
    "--success": added,
    "--success-ink": mix(added, ink, pick(0.4, 0.35)),
    "--warning": warning,
    "--warning-ink": warningInk,
    "--surface-overlay": alpha(ink, pick(0.025, 0.04)),
    "--surface-overlay-hover": alpha(ink, pick(0.05, 0.07)),
    "--surface-overlay-border": alpha(ink, 0.12),
    "--surface-overlay-muted": alpha(ink, pick(0.02, 0.025)),
    "--scrim": alpha(shadow, pick(0.22, 0.5)),
    "--button-primary-bg": ink,
    "--button-primary-border": ink,
    "--button-primary-ink": s,
    "--button-primary-hover-bg": text,
    "--button-primary-hover-border": text,
    "--button-primary-disabled-bg": lineStrong,
    "--button-primary-disabled-border": lineStrong,
    "--button-primary-disabled-ink": mutedSoft,
    "--code-inline-bg": light ? tint(0.05, 0) : alpha(ink, 0.08),
    // Dark code blocks darken whatever is behind them, glass included.
    "--code-block-bg": light ? tint(0.035, 0) : alpha("#000000", 0.25),
    "--code-ink": fade(0.08, 0.05, 7),
    "--code-border": line,
    "--diff-header-bg": alpha(accent, pick(0.08, 0.1)),
    "--find-match-bg": mix(s, warning, pick(0.3, 0.4)),
    "--find-match-ink": mix(warning, ink, pick(0.6, 0.75)),
    "--find-active-bg": mix(s, warning, pick(0.55, 0.8)),
    "--find-active-ink": light ? mix(warning, ink, 0.8) : s,
    "--summary-card-bg": `linear-gradient(180deg, ${mix(s, warning, pick(0.12, 0.16))} 0%, ${mix(s, warning, pick(0.05, 0.07))} 100%)`,
    "--summary-card-border": alpha(warning, pick(0.3, 0.25)),
    "--summary-eyebrow": warningInk,
    "--glass-border": light ? "rgba(255, 255, 255, 0.2)" : "rgba(0, 0, 0, 0.2)",
    "--shadow-sm": `0 2px 8px ${alpha(shadow, pick(0.04, 0.2))}`,
    "--shadow-md": `0 8px 24px ${alpha(shadow, pick(0.08, 0.3))}`,
    "--shadow-lg": `0 16px 48px ${alpha(shadow, pick(0.12, 0.4))}`,
    "--shadow-xl": `0 32px 80px ${alpha(shadow, pick(0.16, 0.5))}`,
    "--terminal-selection": alpha(accent, pick(0.25, 0.35)),
  };
}

export function themeTokensFor(presetId: ThemePresetId, variant: ResolvedTheme): ThemeTokens {
  return deriveThemeTokens(themePreset(presetId).variants[variant].seed, variant);
}

/** The colour behind the whole window, for the native window background. */
export function windowBackgroundFor(presetId: ThemePresetId, variant: ResolvedTheme): string {
  return themeTokensFor(presetId, variant)["--window"]!;
}

/** Colours shown in the preset picker: sidebar, main, accent, ink. */
export function themeSwatches(presetId: ThemePresetId, variant: ResolvedTheme): readonly string[] {
  const tokens = themeTokensFor(presetId, variant);
  return [tokens["--sidebar"]!, tokens["--main"]!, tokens["--accent"]!, tokens["--text-strong"]!];
}

function seed(
  surface: string,
  ink: string,
  accent: string,
  added: string,
  removed: string,
  warning: string,
): ThemeSeed {
  return { surface, ink, accent, added, removed, warning };
}

type Rgb = readonly [number, number, number];

export function parseHex(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) {
    throw new Error(`Theme colours must be #rrggbb, got ${hex}`);
  }
  const value = Number.parseInt(match[1] ?? "", 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

/** `amount` of the way from `from` to `to`, in sRGB. */
export function mix(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  const channel = (i: 0 | 1 | 2): number => a[i] + (b[i] - a[i]) * amount;
  return toHex([channel(0), channel(1), channel(2)]);
}

/** Fades `ink` toward `surface`, but never below `minContrast` against `against`. */
function fadeWithContrast(
  ink: string,
  surface: string,
  amount: number,
  minContrast: number,
  against: string,
): string {
  let fitted = amount;
  while (fitted > 0 && contrastRatio(mix(ink, surface, fitted), against) < minContrast) {
    fitted = Math.max(0, fitted - 0.01);
  }
  return mix(ink, surface, fitted);
}

/** Moves `color` toward `ink` until it reaches `minContrast` against `surface`. */
function deepenForContrast(
  color: string,
  ink: string,
  surface: string,
  minContrast: number,
): string {
  let amount = 0;
  while (amount < 1 && contrastRatio(mix(color, ink, amount), surface) < minContrast) {
    amount = Math.min(1, amount + 0.02);
  }
  return mix(color, ink, amount);
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function relativeLuminance(color: string): number {
  const [r, g, b] = parseHex(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function alpha(color: string, opacity: number): string {
  const [r, g, b] = parseHex(color);
  return `rgba(${r}, ${g}, ${b}, ${Number(opacity.toFixed(3))})`;
}
