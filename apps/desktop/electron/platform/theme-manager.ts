import { nativeTheme, type BrowserWindow } from "electron";
import { desktopIpc } from "../../contracts/ipc";
import type { ThemeMode } from "../../contracts/desktop-state";

export class ThemeManager {
  private mode: ThemeMode = "system";
  private readonly windows = new Set<BrowserWindow>();

  constructor() {
    nativeTheme.on("updated", () => {
      this.broadcast();
    });
  }

  trackWindow(win: BrowserWindow) {
    if (win.isDestroyed() || this.windows.has(win)) {
      return;
    }
    this.windows.add(win);
    win.once("closed", () => {
      this.windows.delete(win);
    });
  }

  getMode(): ThemeMode {
    return this.mode;
  }

  getResolvedTheme(): "light" | "dark" {
    if (this.mode === "system") {
      return nativeTheme.shouldUseDarkColors ? "dark" : "light";
    }
    return this.mode;
  }

  setMode(mode: ThemeMode) {
    this.mode = mode;
    if (mode === "system") {
      nativeTheme.themeSource = "system";
    } else {
      nativeTheme.themeSource = mode;
    }
    this.broadcast();
  }

  private broadcast() {
    for (const window of this.windows) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(desktopIpc.themeChanged, this.getResolvedTheme());
      }
    }
  }
}
