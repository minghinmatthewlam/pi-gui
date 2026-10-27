import { expect, test } from "@playwright/test";
import { EditorService, launchEditorCommand } from "../../electron/platform/editors/editor-service";
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

/** Synchronous fakes for the host's reads, so each test states plain facts. */
interface HostFacts {
  readonly platform: NodeJS.Platform;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (absolutePath: string) => boolean;
  readonly isExecutable?: (absolutePath: string) => boolean;
  readonly listDirectory?: (absolutePath: string) => readonly string[];
  readonly runCommand?: (command: string, args: readonly string[]) => string | undefined;
}

function host(facts: HostFacts): EditorDetectionHost {
  const { exists, isExecutable, listDirectory, runCommand } = facts;
  return {
    platform: facts.platform,
    homeDir: facts.homeDir ?? "/home/dev",
    env: facts.env ?? {},
    exists: async (candidate) => exists?.(candidate) ?? false,
    isExecutable: async (candidate) => isExecutable?.(candidate) ?? false,
    listDirectory: async (directory) => listDirectory?.(directory) ?? [],
    runCommand: async (command, args) => runCommand?.(command, args),
  };
}

const ids = (editors: readonly DetectedEditor[]) => editors.map((editor) => editor.id);

test("macOS detection finds application bundles in both application folders", async () => {
  const editors = await detectInstalledEditors(
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

test("Linux detection prefers a PATH executable over the desktop entry", async () => {
  const editors = await detectInstalledEditors(
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

test("Linux detection falls back to the desktop entry when the PATH executable is absent", async () => {
  const editors = await detectInstalledEditors(
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

test("Linux detection reads desktop entries and prefers gtk-launch", async () => {
  const editors = await detectInstalledEditors(
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

test("Linux detection matches any known desktop entry id for an editor", async () => {
  const editors = await detectInstalledEditors(
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

test("Linux detection falls back to gio when gtk-launch is absent", async () => {
  const editors = await detectInstalledEditors(
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

test("Windows detection finds program files installs without LOCALAPPDATA", async () => {
  const editors = await detectInstalledEditors(
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

test("Windows detection resolves every install root from the environment", async () => {
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

test("Windows detection finds the editors with known install paths", async () => {
  const editors = await detectInstalledEditors(
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

test("Windows detection finds Android Studio's default Program Files install", async () => {
  const editors = await detectInstalledEditors(
    host({
      platform: "win32",
      homeDir: "C:\\Users\\dev",
      env: {
        LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
        PATH: "",
      },
      exists: (candidate) =>
        candidate === "C:\\Program Files\\Android\\Android Studio\\bin\\studio64.exe",
    }),
  );

  expect(ids(editors)).toEqual(["android-studio"]);
  expect(editors[0]?.launch).toEqual({
    kind: "command",
    commandPath: "C:\\Program Files\\Android\\Android Studio\\bin\\studio64.exe",
  });
});

test("Windows detection ignores a .cmd shim on PATH", async () => {
  const editors = await detectInstalledEditors(
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

test("Windows detection checks installed programs before PATH", async () => {
  const editors = await detectInstalledEditors(
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

test("Windows detection skips program lookups without LOCALAPPDATA", async () => {
  const editors = await detectInstalledEditors(
    host({
      platform: "win32",
      homeDir: "C:\\Users\\dev",
      env: { PATH: "C:\\Users\\dev\\bin" },
      exists: (candidate) => candidate === "C:\\Users\\dev\\bin\\cursor.exe",
    }),
  );

  expect(ids(editors)).toEqual(["cursor"]);
});

test("resolvePosixCommand keeps PATH order and rejects non-executables", async () => {
  const detected = await resolvePosixCommand(
    host({
      platform: "linux",
      env: { PATH: "/opt/bin:/usr/bin" },
      isExecutable: (candidate) => candidate === "/opt/bin/code" || candidate === "/usr/bin/code",
    }),
    "code",
  );

  expect(detected).toBe("/opt/bin/code");
});

test("launch commands hand the checkout to each launch kind", async () => {
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
    waitForExit: true,
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
  ).toEqual({ command: "/usr/bin/cursor", args: [workspacePath], waitForExit: false });
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
    waitForExit: true,
  });
});

/** A real child process that exits with `code`. */
function nodeExiting(code: number): { command: string; args: readonly string[] } {
  return { command: process.execPath, args: ["-e", `process.exit(${code});`] };
}

test("a launcher that exits non-zero fails the launch", async () => {
  await expect(launchEditorCommand({ ...nodeExiting(1), waitForExit: true })).rejects.toThrow(
    /exit code 1/,
  );
});

test("a launcher settles when it exits, even while the editor it started keeps running", async () => {
  // The launcher starts a long-lived child that inherits its stdio, as gio does.
  const editor = `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "inherit", detached: true }).unref();`;
  const startedAt = Date.now();
  await launchEditorCommand({
    command: process.execPath,
    args: ["-e", editor],
    waitForExit: true,
  });
  expect(Date.now() - startedAt).toBeLessThan(3000);
});

test("a launcher that exits zero succeeds", async () => {
  await expect(launchEditorCommand({ ...nodeExiting(0), waitForExit: true })).resolves.toBe(
    undefined,
  );
});

test("an editor process succeeds once it starts, whatever it does afterwards", async () => {
  await expect(launchEditorCommand({ ...nodeExiting(1), waitForExit: false })).resolves.toBe(
    undefined,
  );
});

test("a launch that cannot start fails", async () => {
  await expect(
    launchEditorCommand({ command: "/nonexistent/pi-gui-editor", args: [], waitForExit: true }),
  ).rejects.toThrow(/ENOENT/);
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

test("EditorService lists detected editors without a preference", async () => {
  const service = new EditorService({
    detect: async () => [detectedEditor],
    detectDefault: async () => undefined,
    launch: () => Promise.resolve(),
  });

  expect(await service.list()).toEqual({
    editors: [{ id: "vscode", label: "Visual Studio Code", shortLabel: "vscode" }],
  });
});

test("EditorService falls back to the OS default handler", async () => {
  const service = new EditorService({
    detect: async () => [cursorEditor, detectedEditor],
    detectDefault: async () => "vscode",
    launch: () => Promise.resolve(),
  });

  expect(await service.list()).toEqual({
    editors: [
      { id: "cursor", label: "Cursor", shortLabel: "Cursor" },
      { id: "vscode", label: "Visual Studio Code", shortLabel: "vscode" },
    ],
    preferredEditorId: "vscode",
  });
});

test("EditorService keeps a user pick over the OS default", async () => {
  const service = new EditorService({
    detect: async () => [cursorEditor, detectedEditor],
    detectDefault: async () => "vscode",
    launch: () => Promise.resolve(),
  });

  await service.open("/tmp/project", "cursor");
  expect((await service.list()).preferredEditorId).toBe("cursor");
});

test("EditorService ignores an OS default that is not installed", async () => {
  const service = new EditorService({
    detect: async () => [detectedEditor],
    detectDefault: async () => "cursor",
    launch: () => Promise.resolve(),
  });

  expect((await service.list()).preferredEditorId).toBeUndefined();
});

test("EditorService probes the OS default once and reuses the answer", async () => {
  let probes = 0;
  const service = new EditorService({
    detect: async () => [detectedEditor],
    detectDefault: async () => {
      probes += 1;
      return "vscode";
    },
    launch: () => Promise.resolve(),
  });

  await service.list();
  await service.list();
  expect(probes).toBe(1);
  expect((await service.list()).preferredEditorId).toBe("vscode");
});

test("EditorService shares one in-flight probe between concurrent requests", async () => {
  let probes = 0;
  let finishProbe: (editors: readonly DetectedEditor[]) => void = () => {};
  const service = new EditorService({
    detect: () => {
      probes += 1;
      return new Promise((resolve) => {
        finishProbe = resolve;
      });
    },
    detectDefault: async () => undefined,
    launch: () => Promise.resolve(),
  });

  const first = service.list();
  const second = service.list();
  finishProbe([detectedEditor]);

  expect(await first).toEqual(await second);
  expect((await first).editors.map((editor) => editor.id)).toEqual(["vscode"]);
  expect(probes).toBe(1);
});

test("EditorService retries detection after a failed probe", async () => {
  let probes = 0;
  const service = new EditorService({
    detect: async () => {
      probes += 1;
      if (probes === 1) {
        throw new Error("probe failed");
      }
      return [detectedEditor];
    },
    detectDefault: async () => undefined,
    launch: () => Promise.resolve(),
  });

  await expect(service.list()).rejects.toThrow("probe failed");
  expect((await service.list()).editors).toHaveLength(1);
  expect(probes).toBe(2);
});

test("EditorService re-probes the OS default along with the editors", async () => {
  let probes = 0;
  const service = new EditorService({
    detect: async () => {
      probes += 1;
      return probes === 1 ? [] : [detectedEditor];
    },
    detectDefault: async (editors) => editors[0]?.id,
    launch: () => Promise.resolve(),
  });

  expect(await service.list()).toEqual({ editors: [] });
  await expect(service.select("not-an-editor")).rejects.toThrow("Unknown editor");
  expect((await service.list()).preferredEditorId).toBe("vscode");
});

test("EditorService.select records a pick without launching anything", async () => {
  let launches = 0;
  const service = new EditorService({
    detect: async () => [cursorEditor, detectedEditor],
    detectDefault: async () => "vscode",
    launch: () => {
      launches += 1;
      return Promise.resolve();
    },
  });

  expect(await service.select("cursor")).toEqual({
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
    detect: async () => [detectedEditor],
    detectDefault: async () => undefined,
    launch: () => {
      launches += 1;
      return Promise.resolve();
    },
  });

  await expect(service.select("not-an-editor")).rejects.toThrow("Unknown editor: not-an-editor");
  expect(launches).toBe(0);
  expect((await service.list()).preferredEditorId).toBeUndefined();
});

test("EditorService opens a known editor and remembers it as the preference", async () => {
  const launches: { command: string; args: readonly string[] }[] = [];
  const service = new EditorService({
    detect: async () => [detectedEditor],
    detectDefault: async () => undefined,
    launch: ({ command, args }) => {
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
    detect: async () => [detectedEditor],
    detectDefault: async () => undefined,
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
    detect: async () => {
      probes += 1;
      return probes === 1 ? [] : [detectedEditor];
    },
    detectDefault: async () => undefined,
    launch: () => Promise.resolve(),
  });

  expect((await service.list()).editors).toEqual([]);
  await service.open("/tmp/project", "vscode");
  expect(probes).toBe(2);
});

test("EditorService drops a failed editor and its preference", async () => {
  let probes = 0;
  const service = new EditorService({
    detect: async () => {
      probes += 1;
      return probes === 1 ? [detectedEditor] : [];
    },
    detectDefault: async () => undefined,
    launch: () => Promise.reject(new Error("ENOENT")),
  });

  await expect(service.open("/tmp/project", "vscode")).rejects.toThrow("ENOENT");
  expect(await service.list()).toEqual({ editors: [] });
});

test("OS default detection maps the Linux folder handler to a detected editor", async () => {
  const defaultId = await detectDefaultEditorId(
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

test("OS default detection ignores a handler that is not a known editor", async () => {
  const defaultId = await detectDefaultEditorId(
    host({ platform: "linux", runCommand: () => "org.gnome.Nautilus.desktop\n" }),
    [detectedEditor],
  );

  expect(defaultId).toBeUndefined();
});

test("OS default detection ignores a known handler that is not installed", async () => {
  const defaultId = await detectDefaultEditorId(
    host({ platform: "linux", runCommand: () => "cursor.desktop\n" }),
    [detectedEditor],
  );

  expect(defaultId).toBeUndefined();
});

test("OS default detection answers nothing when the probe command is missing", async () => {
  const defaultId = await detectDefaultEditorId(host({ platform: "linux" }), [detectedEditor]);

  expect(defaultId).toBeUndefined();
});

test("macOS default detection matches the LaunchServices handler by bundle id", async () => {
  const defaultId = await detectDefaultEditorId(
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

test("macOS default detection answers nothing without the preferences plist", async () => {
  const defaultId = await detectDefaultEditorId(
    host({
      platform: "darwin",
      exists: () => false,
      runCommand: () => "{}",
    }),
    [detectedEditor],
  );

  expect(defaultId).toBeUndefined();
});

test("Windows default detection matches the Directory shell command to an install path", async () => {
  const defaultId = await detectDefaultEditorId(
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

test("Windows default detection falls back to HKCR and matches without quotes", async () => {
  const defaultId = await detectDefaultEditorId(
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

test("Windows default detection answers nothing when the command path is unknown", async () => {
  const defaultId = await detectDefaultEditorId(
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
