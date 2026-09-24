import { expect, test } from "@playwright/test";
import {
  desktopCommands,
  getSidePanelTabCommand,
  getSidePanelTabShortcutLabel,
  sidePanelTabIndex,
} from "../../contracts/ipc";
import { nextSidePanelTabHintsVisible } from "../../src/features/workbench/side-panel-tab-hints";

const chord = (held: string, key: string, code = `Digit${key}`) => ({
  meta: held.includes("meta"),
  control: held.includes("ctrl"),
  alt: held.includes("alt"),
  shift: held.includes("shift"),
  key,
  code,
});

test("maps Control+1-9 on macOS and Alt+1-9 elsewhere to side panel tabs", () => {
  expect(getSidePanelTabCommand("darwin", chord("ctrl", "1"))).toBe(
    desktopCommands.selectSidePanelTab1,
  );
  expect(getSidePanelTabCommand("darwin", chord("ctrl", "9"))).toBe(
    desktopCommands.selectSidePanelTab9,
  );
  expect(getSidePanelTabCommand("linux", chord("alt", "2"))).toBe(
    desktopCommands.selectSidePanelTab2,
  );
  expect(getSidePanelTabCommand("win32", chord("alt", "3"))).toBe(
    desktopCommands.selectSidePanelTab3,
  );
  // AZERTY reports the symbol as the key; the physical digit still counts.
  expect(getSidePanelTabCommand("linux", chord("alt", "&", "Digit1"))).toBe(
    desktopCommands.selectSidePanelTab1,
  );
  expect(sidePanelTabIndex(desktopCommands.selectSidePanelTab4)).toBe(3);
  expect(sidePanelTabIndex(desktopCommands.selectRecentThread4)).toBeUndefined();
});

test("leaves thread chords, extra modifiers, 0 and keypad digits alone", () => {
  // Cmd+1 on macOS and Ctrl+1 elsewhere switch threads.
  expect(getSidePanelTabCommand("darwin", chord("meta", "1"))).toBeUndefined();
  expect(getSidePanelTabCommand("linux", chord("ctrl", "1"))).toBeUndefined();
  expect(getSidePanelTabCommand("darwin", chord("alt", "1"))).toBeUndefined();
  expect(getSidePanelTabCommand("darwin", chord("ctrl meta", "1"))).toBeUndefined();
  expect(getSidePanelTabCommand("darwin", chord("ctrl shift", "1"))).toBeUndefined();
  // AltGr reports Control and Alt on Windows.
  expect(getSidePanelTabCommand("win32", chord("ctrl alt", "1"))).toBeUndefined();
  expect(getSidePanelTabCommand("linux", chord("alt", "0"))).toBeUndefined();
  // Windows Alt codes type characters from the keypad.
  expect(getSidePanelTabCommand("win32", chord("alt", "1", "Numpad1"))).toBeUndefined();
});

test("labels tab shortcuts per platform", () => {
  expect(getSidePanelTabShortcutLabel("darwin", 2)).toBe("⌃2");
  expect(getSidePanelTabShortcutLabel("linux", 2)).toBe("Alt+2");
  expect(getSidePanelTabShortcutLabel("win32", 9)).toBe("Alt+9");
});

/** Each entry is "down|up <key> [flags]": the modifiers the event reports held. */
function hints(platform: NodeJS.Platform, events: readonly string[]): boolean {
  let visible = false;
  for (const entry of events) {
    const [type, key, ...held] = entry.split(" ");
    visible = nextSidePanelTabHintsVisible(
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

test("shows tab hints while Control is held on macOS and Alt elsewhere", () => {
  expect(hints("darwin", ["down Control ctrl"])).toBe(true);
  expect(hints("darwin", ["down Meta meta"])).toBe(false);
  expect(hints("linux", ["down Alt alt"])).toBe(true);
  expect(hints("linux", ["down Control ctrl"])).toBe(false);
  expect(hints("darwin", ["down Control ctrl", "up Control"])).toBe(false);
  expect(hints("linux", ["down Alt alt", "up Alt"])).toBe(false);
});

test("keeps tab hints through tab switches, including from the terminal", () => {
  expect(hints("darwin", ["down Control ctrl", "down 2 ctrl", "up 2 ctrl"])).toBe(true);
  expect(hints("linux", ["down Alt alt", "down 1 alt terminal", "down 3 alt"])).toBe(true);
  expect(hints("darwin", ["down Control ctrl", "down Tab ctrl"])).toBe(false);
  expect(hints("linux", ["down Alt alt", "down Control alt ctrl"])).toBe(false);
});
