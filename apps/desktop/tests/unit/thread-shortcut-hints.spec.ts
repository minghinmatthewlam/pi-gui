import { expect, test } from "@playwright/test";
import { nextThreadShortcutHintsVisible } from "../../src/features/threads/thread-shortcut-hints";

function run(platform: NodeJS.Platform, events: readonly string[]): boolean {
  let visible = false;
  for (const entry of events) {
    const [type, key, ...held] = entry.split(" ");
    visible = nextThreadShortcutHintsVisible(
      visible,
      {
        type: type === "down" ? "keydown" : "keyup",
        key,
        shiftKey: held.includes("shift"),
        altKey: held.includes("alt"),
      },
      platform,
    );
  }
  return visible;
}

test("shows hints for Command on macOS and Control elsewhere", () => {
  expect(run("darwin", ["down Meta"])).toBe(true);
  expect(run("darwin", ["down Control"])).toBe(false);
  expect(run("linux", ["down Control"])).toBe(true);
  expect(run("win32", ["down Meta"])).toBe(false);
});

test("hides hints on release", () => {
  expect(run("darwin", ["down Meta", "up Meta"])).toBe(false);
  expect(run("linux", ["down Control", "up Control"])).toBe(false);
});

test("hides hints once a chord key is pressed until the modifier is pressed again", () => {
  // The digit keyup still carries the modifier; it must not bring hints back.
  expect(run("darwin", ["down Meta", "down 1", "up 1"])).toBe(false);
  expect(run("darwin", ["down Meta", "down Shift shift", "up Shift"])).toBe(false);
  expect(run("darwin", ["down Meta", "down Alt alt", "up Alt"])).toBe(false);
  expect(run("darwin", ["down Meta", "down 1", "up 1", "down Meta"])).toBe(true);
});

test("ignores the modifier when Shift or AltGr is part of the press", () => {
  expect(run("darwin", ["down Shift shift", "down Meta shift"])).toBe(false);
  expect(run("win32", ["down Control", "down AltGraph alt"])).toBe(false);
});
