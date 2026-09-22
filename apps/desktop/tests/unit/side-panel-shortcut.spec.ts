import { expect, test } from "@playwright/test";
import {
  desktopCommands,
  getDesktopCommandFromShortcut,
  getSidePanelToggleShortcutLabel,
  isCloseFocusedSurfaceShortcut,
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
  expect(
    getDesktopCommandFromShortcut({ modifier: true, shift: false, key: "d", code: "KeyD" }),
  ).toBe(desktopCommands.toggleChanges);
  expect(getSidePanelToggleShortcutLabel("darwin")).toBe("⌘⌥B");
  expect(getSidePanelToggleShortcutLabel("linux")).toBe("Ctrl+Alt+B");
  expect(getSidePanelToggleShortcutLabel("win32")).toBe("Ctrl+Alt+B");
  expect(
    getDesktopCommandFromShortcut({
      modifier: true,
      alt: false,
      shift: false,
      key: "w",
      code: "KeyW",
    }),
  ).toBeUndefined();
});

test("maps platform Ctrl or Cmd+W to closing the focused surface", () => {
  expect(
    isCloseFocusedSurfaceShortcut({
      meta: false,
      control: true,
      alt: false,
      shift: false,
      key: "w",
      code: "KeyW",
      platform: "linux",
    }),
  ).toBe(true);
  expect(
    isCloseFocusedSurfaceShortcut({
      meta: false,
      control: true,
      alt: false,
      shift: false,
      key: "w",
      code: "KeyW",
      platform: "win32",
    }),
  ).toBe(true);
  expect(
    isCloseFocusedSurfaceShortcut({
      meta: true,
      control: false,
      alt: false,
      shift: false,
      key: "w",
      code: "KeyW",
      platform: "darwin",
    }),
  ).toBe(true);
  expect(
    isCloseFocusedSurfaceShortcut({
      meta: false,
      control: true,
      alt: false,
      shift: false,
      key: "w",
      code: "KeyW",
      platform: "darwin",
    }),
  ).toBe(false);
  expect(
    isCloseFocusedSurfaceShortcut({
      meta: true,
      control: true,
      alt: false,
      shift: false,
      key: "w",
      code: "KeyW",
      platform: "linux",
    }),
  ).toBe(false);
  expect(
    isCloseFocusedSurfaceShortcut({
      meta: false,
      control: true,
      alt: true,
      shift: false,
      key: "w",
      code: "KeyW",
      platform: "linux",
    }),
  ).toBe(false);
  expect(
    isCloseFocusedSurfaceShortcut({
      meta: false,
      control: true,
      alt: false,
      shift: true,
      key: "w",
      code: "KeyW",
      platform: "linux",
    }),
  ).toBe(false);
});
