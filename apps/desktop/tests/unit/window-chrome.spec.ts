import { expect, test } from "@playwright/test";
import { drawWindowControlsArgument } from "../../contracts/ipc";
import { windowChromeArguments, windowChromeOptions } from "../../electron/windows/window-chrome";

/**
 * Only Linux gets a frameless window (the renderer draws its title bar there).
 * macOS and Windows must keep the chrome they shipped with. Runs in Node.
 */

test("macOS keeps the inset title bar and traffic lights", () => {
  expect(windowChromeOptions("darwin")).toEqual({
    titleBarStyle: "hiddenInset",
    autoHideMenuBar: false,
    trafficLightPosition: { x: 18, y: 18 },
  });
  expect(windowChromeArguments("darwin")).toEqual([]);
});

test("Windows keeps its existing window chrome", () => {
  expect(windowChromeOptions("win32")).toEqual({
    titleBarStyle: "hiddenInset",
    autoHideMenuBar: true,
    trafficLightPosition: { x: 18, y: 18 },
  });
  expect(windowChromeArguments("win32")).toEqual([]);
});

test("Linux hides the native title bar and menu bar", () => {
  expect(windowChromeOptions("linux")).toEqual({
    titleBarStyle: "hidden",
    autoHideMenuBar: true,
    trafficLightPosition: { x: 18, y: 18 },
  });
  expect(windowChromeArguments("linux")).toEqual([drawWindowControlsArgument]);
});
