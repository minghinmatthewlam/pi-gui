import { nativeTheme, type BrowserWindow } from "electron";
import { desktopIpc } from "../src/ipc";
import type { ThemeMode } from "../src/desktop-state";

// Window Controls Overlay caption colors for the Windows immersive title bar.
export function windowsTitleBarOverlay(theme: "light" | "dark"): {
  color: string;
  symbolColor: string;
  height: number;
} {
  // Transparent so the buttons blend with whatever view is behind them; only the
  // glyph color is themed.
  return {
    color: "#00000000",
    symbolColor: theme === "dark" ? "#e6e6e6" : "#2b2b2b",
    height: 52,
  };
}

export class ThemeManager {
  private mode: ThemeMode = "system";
  private window: BrowserWindow | null = null;

  constructor() {
    nativeTheme.on("updated", () => {
      this.broadcast();
    });
  }

  setWindow(win: BrowserWindow) {
    this.window = win;
    this.applyTitleBarOverlay();
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
    this.applyTitleBarOverlay();
    this.window?.webContents.send(desktopIpc.themeChanged, this.getResolvedTheme());
  }

  private applyTitleBarOverlay() {
    if (process.platform !== "win32" || !this.window || this.window.isDestroyed()) {
      return;
    }
    try {
      this.window.setTitleBarOverlay(windowsTitleBarOverlay(this.getResolvedTheme()));
    } catch {
      // Only valid when the window was created with an overlay enabled.
    }
  }
}
