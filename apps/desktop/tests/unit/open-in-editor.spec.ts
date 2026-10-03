import { expect, test } from "@playwright/test";
import { EditorService } from "../../electron/platform/editors/editor-service";
import {
  buildEditorLaunchCommand,
  detectDefaultEditorId,
  detectInstalledEditors,
  resolvePosixCommand,
  resolveWindowsInstallRoot,
  type DetectedEditor,
  type EditorDetectionHost,
} from "../../electron/platform/editors/detect-editors";

/**
 * Editor detection and launch building. These run in Node with an injected
 * filesystem host, so each platform's probe is exercised without the app and
 * without an editor actually installed.
 */

function host(overrides: Partial<EditorDetectionHost> & Pick<EditorDetectionHost, "platform">) {
  return {
    homeDir: "/home/dev",
    env: {},
    exists: () => false,
    isExecutable: () => false,
    listDirectory: () => [],
    runCommand: () => undefined,
    ...overrides,
  } satisfies EditorDetectionHost;
}

const ids = (editors: readonly DetectedEditor[]) => editors.map((editor) => editor.id);

test("macOS detection finds application bundles in both application folders", () => {
  const editors = detectInstalledEditors(
    host({
      platform: "darwin",
      homeDir: "/Users/dev",
      exists: (candidate) =>
        candidate === "/Applications/Visual Studio Code.app" ||
        candidate === "/Users/dev/Applications/Zed.app",
    }),
  );

  expect(ids(editors)).toEqual(["vscode", "zed"]);
  expect(editors[0]?.launch).toEqual({
    kind: "mac-app",
    appPath: "/Applications/Visual Studio Code.app",
  });
});

test("Linux detection prefers a PATH executable over the desktop entry", () => {
  const editors = detectInstalledEditors(
    host({
      platform: "linux",
      homeDir: "/home/dev",
      env: { PATH: "/usr/local/bin:/usr/bin" },
      listDirectory: (directory) =>
        directory === "/usr/share/applications" ? ["android-studio.desktop"] : [],
      exists: (candidate) => candidate === "/usr/share/applications/android-studio.desktop",
      isExecutable: (candidate) => candidate === "/usr/local/bin/studio",
    }),
  );

  expect(ids(editors)).toEqual(["android-studio"]);
  expect(editors[0]?.launch).toEqual({ kind: "command", commandPath: "/usr/local/bin/studio" });
});

test("Linux detection falls back to the desktop entry when the PATH executable is absent", () => {
  const editors = detectInstalledEditors(
    host({
      platform: "linux",
      homeDir: "/home/dev",
      env: { PATH: "/usr/bin" },
      listDirectory: (directory) =>
        directory === "/usr/share/applications" ? ["android-studio.desktop"] : [],
      exists: (candidate) => candidate === "/usr/share/applications/android-studio.desktop",
    }),
  );

  expect(ids(editors)).toEqual(["android-studio"]);
  expect(editors[0]?.launch).toMatchObject({
    kind: "desktop-entry",
    desktopId: "android-studio.desktop",
  });
});

test("Linux detection reads desktop entries and prefers gtk-launch", () => {
  const editors = detectInstalledEditors(
    host({
      platform: "linux",
      homeDir: "/home/dev",
      env: { PATH: "/usr/local/bin:/usr/bin" },
      listDirectory: (directory) =>
        directory === "/usr/share/applications" ? ["com.microsoft.VSCode.desktop"] : [],
      exists: (candidate) => candidate === "/usr/share/applications/com.microsoft.VSCode.desktop",
      isExecutable: (candidate) => candidate === "/usr/local/bin/gtk-launch",
    }),
  );

  expect(ids(editors)).toEqual(["vscode"]);
  expect(editors[0]?.launch).toEqual({
    kind: "desktop-entry",
    desktopId: "com.microsoft.VSCode.desktop",
    desktopPath: "/usr/share/applications/com.microsoft.VSCode.desktop",
    launcher: "gtk-launch",
  });
});

test("Linux detection matches any known desktop entry id for an editor", () => {
  const editors = detectInstalledEditors(
    host({
      platform: "linux",
      homeDir: "/home/dev",
      env: { PATH: "/usr/bin" },
      listDirectory: (directory) =>
        directory === "/usr/share/applications" ? ["com.cursor.Cursor.desktop"] : [],
      exists: (candidate) => candidate === "/usr/share/applications/com.cursor.Cursor.desktop",
    }),
  );

  expect(ids(editors)).toEqual(["cursor"]);
});

test("Linux detection falls back to gio when gtk-launch is absent", () => {
  const editors = detectInstalledEditors(
    host({
      platform: "linux",
      homeDir: "/home/dev",
      env: { PATH: "/usr/bin" },
      listDirectory: (directory) =>
        directory === "/home/dev/.local/share/applications" ? ["cursor.desktop"] : [],
      exists: (candidate) => candidate === "/home/dev/.local/share/applications/cursor.desktop",
    }),
  );

  expect(editors[0]?.launch).toMatchObject({ kind: "desktop-entry", launcher: "gio" });
});

test("Windows detection finds program files installs without LOCALAPPDATA", () => {
  const editors = detectInstalledEditors(
    host({
      platform: "win32",
      homeDir: "C:\\Users\\dev",
      env: { ProgramFiles: "C:\\Program Files", PATH: "" },
      exists: (candidate) => candidate === "C:\\Program Files\\Sublime Text 3\\sublime_text.exe",
    }),
  );

  expect(ids(editors)).toEqual(["sublime"]);
  expect(editors[0]?.launch).toEqual({
    kind: "command",
    commandPath: "C:\\Program Files\\Sublime Text 3\\sublime_text.exe",
  });
});

test("Windows detection resolves every install root from the environment", () => {
  const detectionHost = host({
    platform: "win32",
    env: {
      LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    },
  });

  expect(resolveWindowsInstallRoot(detectionHost, "localAppData")).toBe(
    "C:\\Users\\dev\\AppData\\Local",
  );
  expect(resolveWindowsInstallRoot(detectionHost, "programFiles")).toBe("C:\\Program Files");
  expect(resolveWindowsInstallRoot(detectionHost, "programFilesX86")).toBe(
    "C:\\Program Files (x86)",
  );
});

test("Windows detection finds the editors with known install paths", () => {
  const editors = detectInstalledEditors(
    host({
      platform: "win32",
      homeDir: "C:\\Users\\dev",
      env: {
        LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
        PATH: "C:\\Users\\dev\\bin",
      },
      exists: (candidate) =>
        [
          "C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe",
          "C:\\Users\\dev\\AppData\\Local\\Programs\\Windsurf\\Windsurf.exe",
          "C:\\Users\\dev\\AppData\\Local\\Programs\\Android Studio\\bin\\studio64.exe",
          "C:\\Program Files\\Sublime Text\\sublime_text.exe",
          "C:\\Users\\dev\\bin\\cursor.exe",
        ].includes(candidate),
    }),
  );

  expect(ids(editors)).toEqual([
    "cursor",
    "windsurf",
    "vscode-insiders",
    "sublime",
    "android-studio",
  ]);
});

test("Windows detection ignores a .cmd shim on PATH", () => {
  const editors = detectInstalledEditors(
    host({
      platform: "win32",
      homeDir: "C:\\Users\\dev",
      env: { PATH: "C:\\Users\\dev\\bin" },
      exists: (candidate) => candidate === "C:\\Users\\dev\\bin\\cursor.cmd",
    }),
  );

  // The probe looks for `<command>.exe`; a shell shim is not a launchable target.
  expect(ids(editors)).toEqual([]);
});

test("Windows detection checks installed programs before PATH", () => {
  const editors = detectInstalledEditors(
    host({
      platform: "win32",
      homeDir: "C:\\Users\\dev",
      env: {
        LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
        PATH: "C:\\Windows\\System32;C:\\Users\\dev\\bin",
      },
      exists: (candidate) =>
        candidate === "C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" ||
        candidate === "C:\\Users\\dev\\bin\\cursor.exe",
    }),
  );

  expect(ids(editors)).toEqual(["vscode", "cursor"]);
  expect(editors[0]?.launch).toEqual({
    kind: "command",
    commandPath: "C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
  });
});

test("Windows detection skips program lookups without LOCALAPPDATA", () => {
  const editors = detectInstalledEditors(
    host({
      platform: "win32",
      homeDir: "C:\\Users\\dev",
      env: { PATH: "C:\\Users\\dev\\bin" },
      exists: (candidate) => candidate === "C:\\Users\\dev\\bin\\cursor.exe",
    }),
  );

  expect(ids(editors)).toEqual(["cursor"]);
});

test("resolvePosixCommand keeps PATH order and rejects non-executables", () => {
  const detected = resolvePosixCommand(
    host({
      platform: "linux",
      env: { PATH: "/opt/bin:/usr/bin" },
      isExecutable: (candidate) => candidate === "/opt/bin/code" || candidate === "/usr/bin/code",
    }),
    "code",
  );

  expect(detected).toBe("/opt/bin/code");
});

test("launch commands hand the checkout to each launch kind", () => {
  const workspacePath = "/tmp/project";

  expect(
    buildEditorLaunchCommand(
      {
        id: "vscode",
        label: "Visual Studio Code",
        shortLabel: "vscode",
        launch: { kind: "mac-app", appPath: "/Applications/Visual Studio Code.app" },
      },
      workspacePath,
    ),
  ).toEqual({
    command: "open",
    args: ["-a", "/Applications/Visual Studio Code.app", workspacePath],
  });
  expect(
    buildEditorLaunchCommand(
      {
        id: "cursor",
        label: "Cursor",
        shortLabel: "Cursor",
        launch: { kind: "command", commandPath: "/usr/bin/cursor" },
      },
      workspacePath,
    ),
  ).toEqual({ command: "/usr/bin/cursor", args: [workspacePath] });
  expect(
    buildEditorLaunchCommand(
      {
        id: "zed",
        label: "Zed",
        shortLabel: "Zed",
        launch: {
          kind: "desktop-entry",
          desktopId: "dev.zed.Zed.desktop",
          desktopPath: "/usr/share/applications/dev.zed.Zed.desktop",
          launcher: "gio",
        },
      },
      workspacePath,
    ),
  ).toEqual({
    command: "gio",
    args: ["launch", "/usr/share/applications/dev.zed.Zed.desktop", workspacePath],
  });
});

const detectedEditor: DetectedEditor = {
  id: "vscode",
  label: "Visual Studio Code",
  shortLabel: "vscode",
  launch: { kind: "command", commandPath: "/usr/bin/code" },
};

const cursorEditor: DetectedEditor = {
  id: "cursor",
  label: "Cursor",
  shortLabel: "Cursor",
  launch: { kind: "command", commandPath: "/usr/bin/cursor" },
};

test("EditorService lists detected editors without a preference", () => {
  const service = new EditorService({
    detect: () => [detectedEditor],
    detectDefault: () => undefined,
    launch: () => Promise.resolve(),
  });

  expect(service.list()).toEqual({
    editors: [{ id: "vscode", label: "Visual Studio Code", shortLabel: "vscode" }],
  });
});

test("EditorService falls back to the OS default handler", () => {
  const service = new EditorService({
    detect: () => [cursorEditor, detectedEditor],
    detectDefault: () => "vscode",
    launch: () => Promise.resolve(),
  });

  expect(service.list()).toEqual({
    editors: [
      { id: "cursor", label: "Cursor", shortLabel: "Cursor" },
      { id: "vscode", label: "Visual Studio Code", shortLabel: "vscode" },
    ],
    preferredEditorId: "vscode",
  });
});

test("EditorService keeps a user pick over the OS default", async () => {
  const service = new EditorService({
    detect: () => [cursorEditor, detectedEditor],
    detectDefault: () => "vscode",
    launch: () => Promise.resolve(),
  });

  await service.open("/tmp/project", "cursor");
  expect(service.list().preferredEditorId).toBe("cursor");
});

test("EditorService ignores an OS default that is not installed", () => {
  const service = new EditorService({
    detect: () => [detectedEditor],
    detectDefault: () => "cursor",
    launch: () => Promise.resolve(),
  });

  expect(service.list().preferredEditorId).toBeUndefined();
});

test("EditorService probes the OS default once and reuses the answer", () => {
  let probes = 0;
  const service = new EditorService({
    detect: () => [detectedEditor],
    detectDefault: () => {
      probes += 1;
      return "vscode";
    },
    launch: () => Promise.resolve(),
  });

  service.list();
  service.list();
  expect(probes).toBe(1);
  expect(service.list().preferredEditorId).toBe("vscode");
});

test("EditorService.select records a pick without launching anything", async () => {
  let launches = 0;
  const service = new EditorService({
    detect: () => [cursorEditor, detectedEditor],
    detectDefault: () => "vscode",
    launch: () => {
      launches += 1;
      return Promise.resolve();
    },
  });

  expect(service.select("cursor")).toEqual({
    editors: [
      { id: "cursor", label: "Cursor", shortLabel: "Cursor" },
      { id: "vscode", label: "Visual Studio Code", shortLabel: "vscode" },
    ],
    preferredEditorId: "cursor",
  });
  expect(launches).toBe(0);
});

test("EditorService.select rejects an unknown editor without launching anything", async () => {
  let launches = 0;
  const service = new EditorService({
    detect: () => [detectedEditor],
    detectDefault: () => undefined,
    launch: () => {
      launches += 1;
      return Promise.resolve();
    },
  });

  expect(() => service.select("not-an-editor")).toThrow("Unknown editor: not-an-editor");
  expect(launches).toBe(0);
  expect(service.list().preferredEditorId).toBeUndefined();
});

test("EditorService opens a known editor and remembers it as the preference", async () => {
  const launches: { command: string; args: readonly string[] }[] = [];
  const service = new EditorService({
    detect: () => [detectedEditor],
    launch: (command, args) => {
      launches.push({ command, args });
      return Promise.resolve();
    },
  });

  await expect(service.open("/tmp/project", "vscode")).resolves.toEqual({
    editors: [{ id: "vscode", label: "Visual Studio Code", shortLabel: "vscode" }],
    preferredEditorId: "vscode",
  });
  expect(launches).toEqual([{ command: "/usr/bin/code", args: ["/tmp/project"] }]);
});

test("EditorService rejects an unknown editor without launching anything", async () => {
  let launched = 0;
  const service = new EditorService({
    detect: () => [detectedEditor],
    detectDefault: () => undefined,
    launch: () => {
      launched += 1;
      return Promise.resolve();
    },
  });

  await expect(service.open("/tmp/project", "not-an-editor")).rejects.toThrow(
    "Unknown editor: not-an-editor",
  );
  expect(launched).toBe(0);
});

test("EditorService re-probes when the cached list is stale", async () => {
  let probes = 0;
  const service = new EditorService({
    detect: () => {
      probes += 1;
      return probes === 1 ? [] : [detectedEditor];
    },
    detectDefault: () => undefined,
    launch: () => Promise.resolve(),
  });

  expect(service.list().editors).toEqual([]);
  await service.open("/tmp/project", "vscode");
  expect(probes).toBe(2);
});

test("EditorService drops a failed editor and its preference", async () => {
  let probes = 0;
  const service = new EditorService({
    detect: () => {
      probes += 1;
      return probes === 1 ? [detectedEditor] : [];
    },
    detectDefault: () => undefined,
    launch: () => Promise.reject(new Error("ENOENT")),
  });

  await expect(service.open("/tmp/project", "vscode")).rejects.toThrow("ENOENT");
  expect(service.list()).toEqual({ editors: [] });
});

test("OS default detection maps the Linux folder handler to a detected editor", () => {
  const defaultId = detectDefaultEditorId(
    host({
      platform: "linux",
      runCommand: (command, args) =>
        command === "xdg-mime" && args.join(" ") === "query default inode/directory"
          ? "code.desktop\n"
          : undefined,
    }),
    [cursorEditor, detectedEditor],
  );

  expect(defaultId).toBe("vscode");
});

test("OS default detection ignores a handler that is not a known editor", () => {
  const defaultId = detectDefaultEditorId(
    host({ platform: "linux", runCommand: () => "org.gnome.Nautilus.desktop\n" }),
    [detectedEditor],
  );

  expect(defaultId).toBeUndefined();
});

test("OS default detection ignores a known handler that is not installed", () => {
  const defaultId = detectDefaultEditorId(
    host({ platform: "linux", runCommand: () => "cursor.desktop\n" }),
    [detectedEditor],
  );

  expect(defaultId).toBeUndefined();
});

test("OS default detection answers nothing when the probe command is missing", () => {
  const defaultId = detectDefaultEditorId(host({ platform: "linux" }), [detectedEditor]);

  expect(defaultId).toBeUndefined();
});

test("macOS default detection matches the LaunchServices handler by bundle id", () => {
  const defaultId = detectDefaultEditorId(
    host({
      platform: "darwin",
      homeDir: "/Users/dev",
      exists: (candidate) => candidate.endsWith("com.apple.launchservices.secure.plist"),
      runCommand: (command, args) => {
        if (command !== "plutil") {
          return undefined;
        }
        if (args.includes("-convert")) {
          return JSON.stringify({
            LSHandlers: [
              { LSHandlerContentType: "public.jpeg", LSHandlerRoleAll: "com.apple.Preview" },
              { LSHandlerContentType: "public.folder", LSHandlerRoleAll: "com.microsoft.VSCode" },
            ],
          });
        }
        return args.at(-1) === "/Applications/Visual Studio Code.app/Contents/Info.plist"
          ? "com.microsoft.VSCode\n"
          : undefined;
      },
    }),
    [
      {
        id: "vscode",
        label: "Visual Studio Code",
        shortLabel: "vscode",
        launch: { kind: "mac-app", appPath: "/Applications/Visual Studio Code.app" },
      },
    ],
  );

  expect(defaultId).toBe("vscode");
});

test("macOS default detection answers nothing without the preferences plist", () => {
  const defaultId = detectDefaultEditorId(
    host({
      platform: "darwin",
      exists: () => false,
      runCommand: () => "{}",
    }),
    [detectedEditor],
  );

  expect(defaultId).toBeUndefined();
});

test("Windows default detection matches the Directory shell command to an install path", () => {
  const defaultId = detectDefaultEditorId(
    host({
      platform: "win32",
      runCommand: (command, args) => {
        if (command !== "reg") {
          return undefined;
        }
        if (args[1] === "HKCU\\Software\\Classes\\Directory\\shell") {
          return (
            "\r\nHKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\r\n" +
            "    (Default)    REG_SZ    open\r\n\r\n"
          );
        }
        return args[1] === "HKCU\\Software\\Classes\\Directory\\shell\\open\\command"
          ? '    (Default)    REG_SZ    "C:\\Program Files\\Microsoft VS Code\\Code.exe" "%1"\r\n'
          : undefined;
      },
    }),
    [
      {
        id: "vscode",
        label: "Visual Studio Code",
        shortLabel: "vscode",
        launch: { kind: "command", commandPath: "C:\\Program Files\\Microsoft VS Code\\Code.exe" },
      },
    ],
  );

  expect(defaultId).toBe("vscode");
});

test("Windows default detection falls back to HKCR and matches without quotes", () => {
  const defaultId = detectDefaultEditorId(
    host({
      platform: "win32",
      runCommand: (command, args) => {
        if (command !== "reg") {
          return undefined;
        }
        if (args[1] === "HKCU\\Software\\Classes\\Directory\\shell") {
          return undefined;
        }
        if (args[1] === "HKCR\\Directory\\shell") {
          return "    (Default)    REG_SZ    open\n";
        }
        return args[1] === "HKCR\\Directory\\shell\\open\\command"
          ? '    (Default)    REG_SZ    C:\\Users\\dev\\AppData\\Local\\Programs\\Cursor\\Cursor.exe "%V"\n'
          : undefined;
      },
    }),
    [
      {
        id: "cursor",
        label: "Cursor",
        shortLabel: "Cursor",
        launch: {
          kind: "command",
          commandPath: "c:\\users\\dev\\appdata\\local\\programs\\cursor\\cursor.exe",
        },
      },
    ],
  );

  expect(defaultId).toBe("cursor");
});

test("Windows default detection answers nothing when the command path is unknown", () => {
  const defaultId = detectDefaultEditorId(
    host({
      platform: "win32",
      runCommand: (command, args) =>
        command === "reg" && args[1] === "HKCU\\Software\\Classes\\Directory\\shell"
          ? "    (Default)    REG_SZ    open\n"
          : command === "reg" && args[1]?.endsWith("\\open\\command")
            ? '    (Default)    REG_SZ    "C:\\Windows\\explorer.exe" "%V"\n'
            : undefined,
    }),
    [detectedEditor],
  );

  expect(defaultId).toBeUndefined();
});
