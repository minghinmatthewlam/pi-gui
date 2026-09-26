import type { ITheme } from "@xterm/xterm";
import { mix } from "../../../contracts/theme";
import type { ActiveTheme } from "../../ui/active-theme";
import { syntaxThemes } from "../../ui/syntax-highlight";

const ANSI_NAMES = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"] as const;

/**
 * The terminal sits on the app's main surface and takes its 16 ANSI colours
 * from the preset's VS Code theme file, like the syntax colours. Themes
 * without terminal colours fall back to the seed's semantic colours.
 */
export function terminalThemeFor(theme: ActiveTheme): ITheme {
  const { tokens } = theme;
  const token = (name: `--${string}`): string => tokens[name] ?? "";
  const main = token("--main");
  const ink = token("--text-strong");
  const colors = syntaxThemes[theme.syntaxTheme].colors ?? {};
  const fallback: Record<(typeof ANSI_NAMES)[number], string> = {
    Black: theme.variant === "light" ? ink : mix(main, "#000000", 0.3),
    Red: token("--error"),
    Green: token("--success"),
    Yellow: token("--warning"),
    Blue: token("--accent"),
    Magenta: mix(token("--accent"), token("--error"), 0.5),
    Cyan: mix(token("--accent"), token("--success"), 0.5),
    White: theme.variant === "light" ? token("--muted") : ink,
  };
  const ansi: Record<string, string> = {};
  for (const name of ANSI_NAMES) {
    const key = name.charAt(0).toLowerCase() + name.slice(1);
    ansi[key] = colors[`terminal.ansi${name}`] ?? fallback[name];
    ansi[`bright${name}`] =
      colors[`terminal.ansiBright${name}`] ?? colors[`terminal.ansi${name}`] ?? fallback[name];
  }
  return {
    ...ansi,
    background: main,
    foreground: token("--text"),
    cursor: ink,
    cursorAccent: main,
    selectionBackground: token("--terminal-selection"),
  };
}
