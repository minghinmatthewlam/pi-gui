import { expect, test } from "@playwright/test";
import {
  desktopCommands,
  getDesktopCommandFromShortcut,
  getSidePanelToggleShortcutLabel,
} from "../../contracts/ipc";

test("maps Alt+B to the side panel and leaves plain B on the sidebar", () => {
  expect(
    getDesktopCommandFromShortcut({
      modifier: true,
      alt: true,
      shift: false,
      key: "b",
      code: "KeyB",
    }),
  ).toBe(desktopCommands.toggleSidePanel);
  expect(
    getDesktopCommandFromShortcut({
      modifier: true,
      alt: true,
      shift: false,
      key: "∫",
      code: "KeyB",
    }),
  ).toBe(desktopCommands.toggleSidePanel);
  expect(
    getDesktopCommandFromShortcut({
      modifier: true,
      alt: true,
      shift: false,
      key: "j",
      code: "KeyJ",
    }),
  ).toBeUndefined();
  expect(
    getDesktopCommandFromShortcut({
      modifier: true,
      alt: false,
      shift: false,
      key: "b",
      code: "KeyB",
    }),
  ).toBe(desktopCommands.toggleSidebar);
  expect(
    getDesktopCommandFromShortcut({ modifier: true, shift: false, key: "b", code: "KeyB" }),
  ).toBe(desktopCommands.toggleSidebar);
  expect(getSidePanelToggleShortcutLabel("darwin")).toBe("⌘⌥B");
  expect(getSidePanelToggleShortcutLabel("linux")).toBe("Ctrl+Alt+B");
  expect(getSidePanelToggleShortcutLabel("win32")).toBe("Ctrl+Alt+B");
});
