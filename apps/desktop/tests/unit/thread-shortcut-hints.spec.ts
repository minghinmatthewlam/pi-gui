import { expect, test } from "@playwright/test";
import { nextThreadShortcutHintsVisible } from "../../src/features/threads/thread-shortcut-hints";

/** Each entry is "down|up <key> [flags]": the modifiers the event reports held, or "terminal". */
function run(platform: NodeJS.Platform, events: readonly string[]): boolean {
  let visible = false;
  for (const entry of events) {
    const [type, key, ...held] = entry.split(" ");
    visible = nextThreadShortcutHintsVisible(
      visible,
      {
        type: type === "down" ? "keydown" : "keyup",
        key,
        code: /^[0-9]$/.test(key) ? `Digit${key}` : key,
        inTerminal: held.includes("terminal"),
        metaKey: held.includes("meta"),
        ctrlKey: held.includes("ctrl"),
        shiftKey: held.includes("shift"),
        altKey: held.includes("alt"),
      },
      platform,
    );
  }
  return visible;
}

test("shows hints for Command on macOS and Control elsewhere", () => {
  expect(run("darwin", ["down Meta meta"])).toBe(true);
  expect(run("darwin", ["down Control ctrl"])).toBe(false);
  expect(run("linux", ["down Control ctrl"])).toBe(true);
  expect(run("win32", ["down Meta meta"])).toBe(false);
});

test("hides hints on release", () => {
  expect(run("darwin", ["down Meta meta", "up Meta"])).toBe(false);
  expect(run("linux", ["down Control ctrl", "up Control"])).toBe(false);
});

test("keeps hints through thread switches while the modifier is held", () => {
  expect(run("darwin", ["down Meta meta", "down 1 meta", "up 1 meta"])).toBe(true);
  expect(run("darwin", ["down Meta meta", "down 1 meta", "down 3 meta"])).toBe(true);
  expect(run("linux", ["down Control ctrl", "down 2 ctrl", "up 2 ctrl"])).toBe(true);
  // Main can consume the digit keydown, so only its keyup reaches the renderer.
  expect(run("darwin", ["down Meta meta", "up 1 meta"])).toBe(true);
  expect(run("darwin", ["down Meta meta", "down 1 meta", "up 1 meta", "up Meta"])).toBe(false);
});

test("hides hints once another key is pressed until the modifier is pressed again", () => {
  expect(run("darwin", ["down Meta meta", "down k meta", "up k meta"])).toBe(false);
  expect(run("darwin", ["down Meta meta", "down 0 meta"])).toBe(false);
  expect(run("darwin", ["down Meta meta", "down 1 meta shift"])).toBe(false);
  // Ctrl+1-9 in the terminal goes to the shell, not a thread switch.
  expect(run("linux", ["down Control ctrl", "down 1 ctrl terminal"])).toBe(false);
  expect(run("darwin", ["down Meta meta", "down Shift meta shift", "up Shift meta"])).toBe(false);
  expect(run("darwin", ["down Meta meta", "down Alt meta alt", "up Alt meta"])).toBe(false);
  expect(run("darwin", ["down Meta meta", "down k meta", "down Meta meta"])).toBe(true);
});

test("hides hints when an event reports the modifier up without its keyup", () => {
  // macOS can drop the Command keyup after a chord the main process consumed.
  expect(run("darwin", ["down Meta meta", "up 1"])).toBe(false);
  expect(run("linux", ["down Control ctrl", "up 1"])).toBe(false);
});

test("ignores the modifier when Shift or AltGr is part of the press", () => {
  expect(run("darwin", ["down Shift shift", "down Meta meta shift"])).toBe(false);
  expect(run("win32", ["down Control ctrl", "down AltGraph ctrl alt"])).toBe(false);
});
