import type { BrowserWindowConstructorOptions } from "electron";
import { drawWindowControlsArgument } from "../../contracts/ipc";

type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "autoHideMenuBar" | "trafficLightPosition"
>;

// Linux drops the native title bar and menu bar, and the renderer draws its
// own title bar with window controls on every screen. A frameless Electron
// window never shows the menu bar but still registers the default menu's
// accelerators (undo, copy, paste, quit). macOS and Windows keep their
// existing chrome.
function drawsWindowControls(platform: NodeJS.Platform): boolean {
  return platform === "linux";
}

export function windowChromeOptions(platform: NodeJS.Platform): WindowChromeOptions {
  return {
    titleBarStyle: drawsWindowControls(platform) ? "hidden" : "hiddenInset",
    autoHideMenuBar: platform !== "darwin",
    trafficLightPosition: { x: 18, y: 18 },
  };
}

/** Renderer arguments that tell the preload whether to draw window controls. */
export function windowChromeArguments(platform: NodeJS.Platform): string[] {
  return drawsWindowControls(platform) ? [drawWindowControlsArgument] : [];
}
