import { expect, test } from "@playwright/test";
import {
  createChordToggleGate,
  createDesktopCommandSubscription,
  createEarlyModifierChordBuffer,
  desktopCommands,
  getDesktopCommandFromShortcut,
  platformShortcutModifier,
  CHANGES_TOGGLE_DEDUPE_MS,
  createChordPairGate,
  SEARCH_CHORD_TOGGLE_MS,
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

test("Cmd+N and Shift+Cmd+O open a new thread, Shift+Cmd+N does not", () => {
  const press = (key: string, shift: boolean) =>
    getDesktopCommandFromShortcut({ modifier: true, shift, key, code: `Key${key.toUpperCase()}` });
  expect(press("n", false)).toBe(desktopCommands.openNewThread);
  expect(press("O", true)).toBe(desktopCommands.openNewThread);
  // Shift+Cmd+N is New Window, which main handles before commands.
  expect(press("N", true)).toBeUndefined();
  expect(press("o", false)).toBeUndefined();
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
  const allow = createChordToggleGate(SEARCH_CHORD_TOGGLE_MS);
  expect(allow(1_000)).toBe(true);
  expect(allow(1_010)).toBe(false);
  expect(allow(1_199)).toBe(false);
  expect(allow(1_200)).toBe(true);
});

test("search chord gate swallows a second press at 50ms, unlike Changes", () => {
  const search = createChordToggleGate(SEARCH_CHORD_TOGGLE_MS);
  expect(search(1_000)).toBe(true);
  expect(search(1_050)).toBe(false);

  const changes = createChordToggleGate(CHANGES_TOGGLE_DEDUPE_MS);
  expect(changes(1_000)).toBe(true);
  expect(changes(1_000 + CHANGES_TOGGLE_DEDUPE_MS - 1)).toBe(false);
  expect(changes(1_000 + CHANGES_TOGGLE_DEDUPE_MS)).toBe(true);
});

test("chord pair gate collapses one chord seen by main and renderer, not two quick presses", () => {
  const allow = createChordPairGate();
  expect(allow("main", 1_000)).toBe(true);
  expect(allow("renderer", 1_002)).toBe(false);
  // A second physical press, however quick, arrives from the same source.
  expect(allow("main", 1_004)).toBe(true);
  expect(allow("main", 1_005)).toBe(true);
  expect(allow("renderer", 1_000 + 5 + CHANGES_TOGGLE_DEDUPE_MS)).toBe(true);
});
