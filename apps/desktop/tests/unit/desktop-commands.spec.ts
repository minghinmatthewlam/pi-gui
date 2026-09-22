import { expect, test } from "@playwright/test";
import {
  createChordToggleGate,
  createDesktopCommandSubscription,
  createEarlyModifierChordBuffer,
  desktopCommands,
  getDesktopCommandFromShortcut,
  platformShortcutModifier,
} from "../../contracts/ipc";

test("settings follows the platform modifier", () => {
  expect(platformShortcutModifier("darwin", { meta: true, control: false })).toBe(true);
  expect(platformShortcutModifier("darwin", { meta: false, control: true })).toBe(false);
  expect(platformShortcutModifier("linux", { meta: true, control: false })).toBe(false);
  expect(platformShortcutModifier("win32", { meta: false, control: true })).toBe(true);

  const modifier = platformShortcutModifier("darwin", { meta: true, control: false });
  expect(
    getDesktopCommandFromShortcut({
      modifier,
      shift: false,
      key: "Unidentified",
      code: "Comma",
    }),
  ).toBe(desktopCommands.openSettings);
  expect(
    getDesktopCommandFromShortcut({ modifier: false, shift: false, key: "," }),
  ).toBeUndefined();
});

test("keeps a shortcut that arrives before the renderer subscribes", () => {
  const commands = createDesktopCommandSubscription();
  commands.deliver(desktopCommands.openSettings);
  const received: string[] = [];
  const unsubscribe = commands.subscribe((command) => {
    received.push(command);
  });
  expect(received).toEqual([desktopCommands.openSettings]);

  commands.deliver(desktopCommands.toggleSidebar);
  expect(received).toEqual([desktopCommands.openSettings, desktopCommands.toggleSidebar]);

  unsubscribe();
  commands.deliver(desktopCommands.openSettings);
  const next: string[] = [];
  commands.subscribe((command) => {
    next.push(command);
  });
  expect(next).toEqual([desktopCommands.openSettings]);
});

test("maps Changes and thread digits from key or code", () => {
  expect(
    getDesktopCommandFromShortcut({
      modifier: true,
      shift: false,
      key: "Unidentified",
      code: "KeyD",
    }),
  ).toBe(desktopCommands.toggleChanges);
  expect(
    getDesktopCommandFromShortcut({ modifier: true, shift: false, key: "d", code: "KeyD" }),
  ).toBe(desktopCommands.toggleChanges);
  expect(
    getDesktopCommandFromShortcut({
      modifier: true,
      shift: false,
      key: "Unidentified",
      code: "Digit2",
    }),
  ).toBe(desktopCommands.selectRecentThread2);
  expect(
    getDesktopCommandFromShortcut({ modifier: true, shift: false, key: "2", code: "Digit2" }),
  ).toBe(desktopCommands.selectRecentThread2);
});

test("replays search and settings chords that arrive before the listener is armed", () => {
  const buffer = createEarlyModifierChordBuffer();
  buffer.note({ modifier: true, shift: false, key: "f", code: "KeyF" });
  buffer.note({ modifier: true, shift: false, key: "Unidentified", code: "Comma" });
  buffer.note({ modifier: true, shift: true, key: "f", code: "KeyF" });
  buffer.note({ modifier: false, shift: false, key: "f", code: "KeyF" });
  buffer.note({ modifier: true, shift: false, key: "1", code: "Digit1" });
  buffer.note({ modifier: true, shift: false, key: "Unidentified", code: "KeyD" });
  expect(buffer.arm()).toEqual([
    { key: "f", code: "KeyF" },
    { key: "Unidentified", code: "Comma" },
    { key: "1", code: "Digit1" },
    { key: "Unidentified", code: "KeyD" },
  ]);
  buffer.note({ modifier: true, shift: false, key: ",", code: "Comma" });
  expect(buffer.arm()).toEqual([]);
});

test("collapses a second search keydown from the same chord", () => {
  const allow = createChordToggleGate(200);
  expect(allow(1_000)).toBe(true);
  expect(allow(1_010)).toBe(false);
  expect(allow(1_199)).toBe(false);
  expect(allow(1_200)).toBe(true);
});
