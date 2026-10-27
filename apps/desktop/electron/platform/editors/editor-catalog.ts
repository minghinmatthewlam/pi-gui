/**
 * Editors pi-gui knows how to open a checkout in, with the per-platform facts
 * each probe needs. Detection lives in `detect-editors.ts`; this file is data.
 */

export type WindowsInstallRoot = "localAppData" | "programFiles" | "programFilesX86";

export interface WindowsEditorInstall {
  /** Environment root the directory is relative to. */
  readonly root: WindowsInstallRoot;
  /** Directory under that root. */
  readonly directory: string;
  /** Executable inside that directory. */
  readonly executable: string;
}

export interface EditorDefinition {
  readonly id: string;
  readonly label: string;
  /** Compact name for the topbar button, where the full label does not fit. */
  readonly shortLabel: string;
  /** macOS application name without the `.app` suffix. */
  readonly macAppName?: string;
  /** Executable names resolved on the POSIX `PATH`. */
  readonly posixCommands?: readonly string[];
  /** Executable base names resolved as `<name>.exe` on the Windows `PATH`. */
  readonly windowsCommands?: readonly string[];
  readonly windowsInstalls?: readonly WindowsEditorInstall[];
  /** Linux `.desktop` file names, in GLib application-id form. */
  readonly linuxDesktopIds?: readonly string[];
}

/**
 * Order is the menu order. The main button targets the OS default handler when
 * one is detected, the user's last pick after that, and otherwise the first
 * detected entry.
 *
 * An entry's platform fields are the platforms it is detected on. A missing
 * field means the editor has no reliable executable path there, so it is
 * intentionally not offered on that platform rather than silently forgotten.
 */
export const EDITOR_CATALOG: readonly EditorDefinition[] = [
  {
    id: "vscode",
    label: "Visual Studio Code",
    shortLabel: "vscode",
    macAppName: "Visual Studio Code",
    posixCommands: ["code"],
    windowsCommands: ["code"],
    windowsInstalls: [
      { root: "localAppData", directory: "Programs\\Microsoft VS Code", executable: "Code.exe" },
      { root: "programFiles", directory: "Microsoft VS Code", executable: "Code.exe" },
    ],
    linuxDesktopIds: [
      "code.desktop",
      "com.microsoft.VSCode.desktop",
      "com.visualstudio.code.desktop",
      "code_code.desktop",
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    shortLabel: "Cursor",
    macAppName: "Cursor",
    posixCommands: ["cursor"],
    windowsCommands: ["cursor"],
    windowsInstalls: [
      { root: "localAppData", directory: "Programs\\cursor", executable: "Cursor.exe" },
    ],
    linuxDesktopIds: ["cursor.desktop", "com.cursor.Cursor.desktop"],
  },
  {
    id: "zed",
    label: "Zed",
    shortLabel: "Zed",
    macAppName: "Zed",
    posixCommands: ["zed"],
    linuxDesktopIds: ["dev.zed.Zed.desktop"],
  },
  {
    id: "windsurf",
    label: "Windsurf",
    shortLabel: "Windsurf",
    macAppName: "Windsurf",
    posixCommands: ["windsurf"],
    windowsCommands: ["windsurf"],
    windowsInstalls: [
      { root: "localAppData", directory: "Programs\\Windsurf", executable: "Windsurf.exe" },
    ],
    linuxDesktopIds: ["windsurf.desktop"],
  },
  {
    id: "vscode-insiders",
    label: "Visual Studio Code Insiders",
    shortLabel: "vscode insiders",
    macAppName: "Visual Studio Code - Insiders",
    posixCommands: ["code-insiders"],
    windowsCommands: ["code-insiders"],
    windowsInstalls: [
      {
        root: "localAppData",
        directory: "Programs\\Microsoft VS Code Insiders",
        executable: "Code - Insiders.exe",
      },
    ],
    linuxDesktopIds: ["code-insiders.desktop"],
  },
  {
    id: "sublime",
    label: "Sublime Text",
    shortLabel: "Sublime",
    macAppName: "Sublime Text",
    posixCommands: ["subl"],
    windowsInstalls: [
      { root: "programFiles", directory: "Sublime Text", executable: "sublime_text.exe" },
      { root: "programFiles", directory: "Sublime Text 3", executable: "sublime_text.exe" },
    ],
    linuxDesktopIds: ["sublime_text.desktop"],
  },
  {
    id: "webstorm",
    label: "WebStorm",
    shortLabel: "WebStorm",
    macAppName: "WebStorm",
    posixCommands: ["webstorm"],
    linuxDesktopIds: ["jetbrains-webstorm.desktop"],
  },
  {
    id: "intellij",
    label: "IntelliJ IDEA",
    shortLabel: "IntelliJ",
    macAppName: "IntelliJ IDEA",
    posixCommands: ["idea"],
    linuxDesktopIds: ["jetbrains-idea.desktop", "jetbrains-idea-ce.desktop"],
  },
  {
    id: "pycharm",
    label: "PyCharm",
    shortLabel: "PyCharm",
    macAppName: "PyCharm",
    posixCommands: ["pycharm"],
    linuxDesktopIds: ["jetbrains-pycharm.desktop", "jetbrains-pycharm-ce.desktop"],
  },
  {
    id: "android-studio",
    label: "Android Studio",
    shortLabel: "Android Studio",
    macAppName: "Android Studio",
    posixCommands: ["studio"],
    windowsInstalls: [
      {
        root: "localAppData",
        directory: "Programs\\Android Studio",
        executable: "bin\\studio64.exe",
      },
    ],
    linuxDesktopIds: ["android-studio.desktop", "android-studio_android-studio.desktop"],
  },
  {
    id: "xcode",
    label: "Xcode",
    shortLabel: "Xcode",
    macAppName: "Xcode",
  },
];
