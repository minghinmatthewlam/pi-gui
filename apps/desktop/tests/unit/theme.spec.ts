import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { themePresetIds } from "../../contracts/desktop-state";
import {
  contrastRatio,
  deriveThemeTokens,
  themePresets,
  themeTokensFor,
  type ResolvedTheme,
} from "../../contracts/theme";
import { highlighterReady, highlightLine, syntaxThemes } from "../../src/ui/syntax-highlight";

const variants: readonly ResolvedTheme[] = ["light", "dark"];
const stylesDir = join(__dirname, "../../src/styles");

test("every preset id has exactly one seeded preset", () => {
  expect(themePresets.map((preset) => preset.id)).toEqual([...themePresetIds]);
});

test("every preset keeps text readable in both variants", () => {
  for (const preset of themePresets) {
    for (const variant of variants) {
      const tokens = themeTokensFor(preset.id, variant);
      const ratio = (a: `--${string}`, b: `--${string}`): number =>
        contrastRatio(tokens[a]!, tokens[b]!);
      const label = `${preset.id} ${variant}`;
      for (const background of ["--main", "--sidebar"] as const) {
        expect(ratio("--text", background), label).toBeGreaterThanOrEqual(4.5);
        expect(ratio("--muted", background), label).toBeGreaterThanOrEqual(4.5);
        expect(ratio("--muted-subtle", background), label).toBeGreaterThanOrEqual(3);
        expect(ratio("--muted-icon", background), label).toBeGreaterThanOrEqual(3);
      }
      expect(ratio("--accent", "--surface"), label).toBeGreaterThanOrEqual(3);
      expect(ratio("--button-primary-ink", "--button-primary-bg"), label).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(ratio("--find-match-ink", "--find-match-bg"), label).toBeGreaterThanOrEqual(3);
      expect(ratio("--find-active-ink", "--find-active-bg"), label).toBeGreaterThanOrEqual(3);
    }
  }
});

test("the Default seed reproduces the hand-tuned Default palette", () => {
  const light = themeTokensFor("default", "light");
  expect(light["--main"]).toBe("#ffffff");
  expect(light["--surface"]).toBe("#ffffff");
  expect(light["--text-strong"]).toBe("#282825");
  expect(light["--button-primary-bg"]).toBe("#282825");
  const dark = themeTokensFor("default", "dark");
  expect(dark["--main"]).toBe("#1d1d1c");
  expect(dark["--text-strong"]).toBe("#eeeeea");
  // Former hand-typed values, within a few steps per channel (the old lines
  // carried a slight warm cast that a straight ink blend does not).
  expectClose(light["--sidebar"]!, "#f6f6f4");
  expectClose(light["--line"]!, "#e4e4df");
  expectClose(light["--text"]!, "#41413d");
  expectClose(dark["--sidebar"]!, "#181818");
  expectClose(dark["--surface"]!, "#222221");
  expectClose(dark["--line"]!, "#343432");
});

test("presets derive every token, so no preset can inherit another's greys", () => {
  const names = Object.keys(themeTokensFor("default", "light")).sort();
  for (const preset of themePresets) {
    for (const variant of variants) {
      const tokens = deriveThemeTokens(preset.variants[variant].seed, variant);
      expect(Object.keys(tokens).sort()).toEqual(names);
    }
  }
  // Warm Gruvbox greys stay warm: red channel above blue, unlike Catppuccin's lavender.
  const gruvboxIcon = themeTokensFor("gruvbox", "light")["--muted-icon"]!;
  expect(Number.parseInt(gruvboxIcon.slice(1, 3), 16)).toBeGreaterThan(
    Number.parseInt(gruvboxIcon.slice(5, 7), 16),
  );
});

test("each preset's surface is its syntax theme's editor background", () => {
  for (const preset of themePresets) {
    if (preset.id === "default") continue;
    for (const variant of variants) {
      const { seed, syntaxTheme } = preset.variants[variant];
      const background = syntaxThemes[syntaxTheme].colors?.["editor.background"];
      expect(background?.toLowerCase(), `${preset.id} ${variant}`).toBe(seed.surface);
    }
  }
});

test("highlights code with the active preset's syntax theme", async () => {
  await highlighterReady;
  const line = 'const preset = "gruvbox"; // seed';
  const colours = new Set<string>();
  for (const preset of themePresets) {
    for (const variant of variants) {
      const tokens = highlightLine(line, "typescript", preset.variants[variant].syntaxTheme);
      expect(tokens?.map((token) => token.content).join("")).toBe(line);
      const keyword = tokens?.find((token) => token.content === "const");
      expect(keyword?.color, `${preset.id} ${variant}`).toMatch(/^#[0-9a-f]{6,8}$/);
      colours.add(keyword!.color!);
    }
  }
  expect(colours.size).toBeGreaterThan(5);
});

test("styles read only defined tokens and no preset-only fallback layer", () => {
  const css = readdirSync(stylesDir)
    .filter((file) => file.endsWith(".css"))
    .map((file) => readFileSync(join(stylesDir, file), "utf8"))
    .join("\n");
  expect(css).not.toMatch(/var\(--theme-/);
  const defined = new Set([
    ...[...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]),
    ...Object.keys(themeTokensFor("default", "light")),
    // Custom properties components set inline (for example the Appearance tiles).
    ...sourceFiles(join(__dirname, "../../src")).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/["`](--[a-z0-9-]+)/g)].map((match) => match[1]),
    ),
  ]);
  // A reference without a fallback must resolve to a defined token.
  const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]))];
  expect(used.filter((name) => !defined.has(name!))).toEqual([]);
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}

function expectClose(actual: string, expected: string): void {
  const channels = (hex: string) =>
    [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  const a = channels(actual);
  const b = channels(expected);
  for (const index of [0, 1, 2]) {
    expect(Math.abs(a[index]! - b[index]!), `${actual} vs ${expected}`).toBeLessThanOrEqual(6);
  }
}
