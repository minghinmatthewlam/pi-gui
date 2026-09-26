import { LRUCache } from "lru-cache";
import bash from "@shikijs/langs/bash";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import python from "@shikijs/langs/python";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import catppuccinLatte from "@shikijs/themes/catppuccin-latte";
import catppuccinMocha from "@shikijs/themes/catppuccin-mocha";
import darkPlus from "@shikijs/themes/dark-plus";
import dracula from "@shikijs/themes/dracula";
import githubDarkDefault from "@shikijs/themes/github-dark-default";
import githubLightDefault from "@shikijs/themes/github-light-default";
import gruvboxDarkMedium from "@shikijs/themes/gruvbox-dark-medium";
import gruvboxLightMedium from "@shikijs/themes/gruvbox-light-medium";
import lightPlus from "@shikijs/themes/light-plus";
import nord from "@shikijs/themes/nord";
import tokyoNight from "@shikijs/themes/tokyo-night";
import { createHighlighterCoreSync, type ThemeRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { SyntaxThemeId } from "../../contracts/theme";
import draculaLight from "./syntax-themes/dracula-light.json";
import nordLight from "./syntax-themes/nord-light.json";
import tokyoNightLight from "./syntax-themes/tokyo-night-light.json";

/*
 * Code colours come from the active preset's VS Code theme file, the same file
 * its seed was taken from. Themes without a shiki bundle (Tokyo Night light,
 * Nord light, Dracula's Alucard) are shipped in ./syntax-themes.
 */

export const syntaxThemes: Readonly<Record<SyntaxThemeId, ThemeRegistration>> = {
  "github-light-default": githubLightDefault,
  "github-dark-default": githubDarkDefault,
  "catppuccin-latte": catppuccinLatte,
  "catppuccin-mocha": catppuccinMocha,
  "tokyo-night-light": tokyoNightLight as ThemeRegistration,
  "tokyo-night": tokyoNight,
  "nord-light": nordLight as ThemeRegistration,
  nord,
  "dracula-light": draculaLight as ThemeRegistration,
  dracula,
  "gruvbox-light-medium": gruvboxLightMedium,
  "gruvbox-dark-medium": gruvboxDarkMedium,
  "light-plus": lightPlus,
  "dark-plus": darkPlus,
};

const highlighter = createHighlighterCoreSync({
  themes: Object.values(syntaxThemes),
  langs: [typescript, tsx, javascript, json, python, bash],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
});

export const MAX_HIGHLIGHTED_LINES = 500;

// TextMate FontStyle.Italic (the enum is not re-exported by shiki).
const ITALIC = 1;

export interface HighlightToken {
  readonly content: string;
  readonly color?: string;
  readonly fontStyle?: "italic";
}

export type HighlightLine = readonly HighlightToken[];

const EXTENSION_TO_LANGUAGE: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "tsx",
  json: "json",
  py: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
};

export function extensionToLanguage(filePath: string): string | undefined {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex < 0) return undefined;
  const ext = filePath.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext];
}

const lineCache = new LRUCache<string, HighlightLine>({ max: 5000 });

export function highlightLine(line: string, language: string, theme: SyntaxThemeId): HighlightLine {
  const cacheKey = `${theme}\0${language}\0${line}`;
  const cached = lineCache.get(cacheKey);
  if (cached) return cached;
  const themeName = syntaxThemes[theme].name ?? theme;
  // The editor foreground is inherited from the surrounding text, so plain
  // tokens carry no colour and follow the app's --code-ink.
  const foreground = highlighter.getTheme(themeName).fg.toLowerCase();
  const tokens = (
    highlighter.codeToTokensBase(line, { lang: language, theme: themeName })[0] ?? []
  ).map((token): HighlightToken => {
    const color = token.color?.toLowerCase();
    return {
      content: token.content,
      ...(color && color !== foreground ? { color } : {}),
      ...(token.fontStyle !== undefined && token.fontStyle & ITALIC
        ? { fontStyle: "italic" as const }
        : {}),
    };
  });
  lineCache.set(cacheKey, tokens);
  return tokens;
}
