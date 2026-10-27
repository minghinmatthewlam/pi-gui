import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { EDITOR_CATALOG, type EditorDefinition, type WindowsInstallRoot } from "./editor-catalog";

export type DetectedEditorLaunch =
  | { readonly kind: "mac-app"; readonly appPath: string }
  | { readonly kind: "command"; readonly commandPath: string }
  | {
      readonly kind: "desktop-entry";
      readonly desktopId: string;
      readonly desktopPath: string;
      readonly launcher: "gtk-launch" | "gio";
    };

export interface DetectedEditor {
  readonly id: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly launch: DetectedEditorLaunch;
}

/**
 * Filesystem and environment facts a probe is allowed to read. Every read is
 * asynchronous because detection runs in Electron main, where a blocking
 * filesystem walk or child process would stall every window's IPC and input.
 */
export interface EditorDetectionHost {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly exists: (absolutePath: string) => Promise<boolean>;
  readonly isExecutable: (absolutePath: string) => Promise<boolean>;
  readonly listDirectory: (absolutePath: string) => Promise<readonly string[]>;
  /** Runs a probe command and returns stdout, or undefined when it fails. */
  readonly runCommand: (command: string, args: readonly string[]) => Promise<string | undefined>;
}

export function detectInstalledEditors(
  host: EditorDetectionHost,
): Promise<readonly DetectedEditor[]> {
  if (host.platform === "darwin") {
    return detectMacEditors(host);
  }
  if (host.platform === "win32") {
    return detectWindowsEditors(host);
  }
  return detectLinuxEditors(host);
}

export function createEditorDetectionHost(): EditorDetectionHost {
  return {
    platform: process.platform,
    homeDir: homedir(),
    env: process.env,
    exists: (absolutePath) =>
      access(absolutePath).then(
        () => true,
        () => false,
      ),
    isExecutable: async (absolutePath) => {
      try {
        await access(absolutePath, constants.X_OK);
        return (await stat(absolutePath)).isFile();
      } catch {
        return false;
      }
    },
    listDirectory: (absolutePath) => readdir(absolutePath).catch(() => []),
    runCommand: (command, args) =>
      new Promise((resolve) => {
        const child = execFile(
          command,
          [...args],
          { encoding: "utf8", timeout: 2_000, windowsHide: true },
          // A missing binary or a non-zero exit just means this probe has no answer.
          (error, stdout) => resolve(error ? undefined : stdout),
        );
        // Probes read nothing; closing stdin makes one that tries see EOF at once.
        child.stdin?.end();
      }),
  };
}

/** A process that opens a checkout in an editor. */
export interface EditorLaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
  /**
   * True for a launcher (`open`, `gio`, `gtk-launch`) that hands the checkout
   * to the editor and exits: its exit code is the only sign the editor is
   * gone. False for the editor's own executable, whose exit code says nothing
   * about the launch (it may keep running, or hand off to a running instance).
   */
  readonly waitForExit: boolean;
}

/** The command that hands `workspacePath` to a detected editor. */
export function buildEditorLaunchCommand(
  editor: DetectedEditor,
  workspacePath: string,
): EditorLaunchCommand {
  switch (editor.launch.kind) {
    case "mac-app":
      return {
        command: "open",
        // The resolved bundle path beats `-a <name>`, which matches by display name.
        args: ["-a", editor.launch.appPath, workspacePath],
        waitForExit: true,
      };
    case "command":
      return { command: editor.launch.commandPath, args: [workspacePath], waitForExit: false };
    case "desktop-entry":
      return editor.launch.launcher === "gtk-launch"
        ? {
            command: "gtk-launch",
            args: [editor.launch.desktopId, workspacePath],
            waitForExit: true,
          }
        : {
            command: "gio",
            args: ["launch", editor.launch.desktopPath, workspacePath],
            waitForExit: true,
          };
  }
}

async function detectMacEditors(host: EditorDetectionHost): Promise<readonly DetectedEditor[]> {
  const pathApi = path.posix;
  const appDirectories = ["/Applications", pathApi.join(host.homeDir, "Applications")];
  const matches = await Promise.all(
    EDITOR_CATALOG.map(async (definition) => {
      if (!definition.macAppName) {
        return undefined;
      }
      const bundleName = `${definition.macAppName}.app`;
      const appPath = await findFirst(
        appDirectories.map((directory) => pathApi.join(directory, bundleName)),
        host.exists,
      );
      return appPath ? toDetectedEditor(definition, { kind: "mac-app", appPath }) : undefined;
    }),
  );
  return matches.filter(isDefined);
}

async function detectLinuxEditors(host: EditorDetectionHost): Promise<readonly DetectedEditor[]> {
  const pathApi = path.posix;
  const applicationDirectories = [
    "/usr/share/applications",
    "/usr/local/share/applications",
    pathApi.join(host.homeDir, ".local/share/applications"),
    "/var/lib/flatpak/exports/share/applications",
    pathApi.join(host.homeDir, ".local/share/flatpak/exports/share/applications"),
    "/var/lib/snapd/desktop/applications",
  ];
  const [listings, gtkLaunch] = await Promise.all([
    Promise.all(applicationDirectories.map((directory) => host.listDirectory(directory))),
    resolvePosixCommand(host, "gtk-launch"),
  ]);
  const available = new Set(listings.flat());
  const matches = await Promise.all(
    EDITOR_CATALOG.map(async (definition): Promise<DetectedEditor | undefined> => {
      // A PATH executable is more reliable than a desktop entry: entries such as
      // Android Studio ship an `Exec=` line without a `%f` field code, and
      // gtk-launch then cannot forward the checkout path.
      const commandPath = await findFirstResult(definition.posixCommands ?? [], (command) =>
        resolvePosixCommand(host, command),
      );
      if (commandPath) {
        return toDetectedEditor(definition, { kind: "command", commandPath });
      }
      const desktopId = definition.linuxDesktopIds?.find((id) => available.has(id));
      if (!desktopId) {
        return undefined;
      }
      const desktopPath =
        (await findFirst(
          applicationDirectories.map((directory) => pathApi.join(directory, desktopId)),
          host.exists,
        )) ?? pathApi.join("/usr/share/applications", desktopId);
      return toDetectedEditor(definition, {
        kind: "desktop-entry",
        desktopId,
        desktopPath,
        launcher: gtkLaunch ? "gtk-launch" : "gio",
      });
    }),
  );
  return matches.filter(isDefined);
}

async function detectWindowsEditors(host: EditorDetectionHost): Promise<readonly DetectedEditor[]> {
  const pathApi = path.win32;
  const matches = await Promise.all(
    EDITOR_CATALOG.map(async (definition) => {
      const installCandidates = (definition.windowsInstalls ?? []).flatMap((install) => {
        const root = resolveWindowsInstallRoot(host, install.root);
        return root ? [pathApi.join(root, install.directory, install.executable)] : [];
      });
      const commandPath =
        (await findFirst(installCandidates, host.exists)) ??
        (await findFirstResult(definition.windowsCommands ?? [], (command) =>
          resolveWindowsCommand(host, `${command}.exe`),
        ));
      return commandPath
        ? toDetectedEditor(definition, { kind: "command", commandPath })
        : undefined;
    }),
  );
  return matches.filter(isDefined);
}

/** First candidate, in order, that passes the asynchronous check. */
async function findFirst(
  candidates: readonly string[],
  check: (candidate: string) => Promise<boolean>,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await check(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** First defined result, in order, of an asynchronous resolver. */
async function findFirstResult(
  inputs: readonly string[],
  resolve: (input: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  for (const input of inputs) {
    const result = await resolve(input);
    if (result) {
      return result;
    }
  }
  return undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** Environment directory a `windowsInstalls` entry is relative to. */
export function resolveWindowsInstallRoot(
  host: EditorDetectionHost,
  root: WindowsInstallRoot,
): string | undefined {
  switch (root) {
    case "localAppData":
      return host.env.LOCALAPPDATA ?? host.env.LocalAppData;
    case "programFiles":
      return host.env.ProgramFiles ?? host.env.PROGRAMFILES;
    case "programFilesX86":
      return host.env["ProgramFiles(x86)"] ?? host.env["PROGRAMFILES(X86)"];
  }
}

function toDetectedEditor(
  definition: EditorDefinition,
  launch: DetectedEditorLaunch,
): DetectedEditor {
  return {
    id: definition.id,
    label: definition.label,
    shortLabel: definition.shortLabel,
    launch,
  };
}

export function resolvePosixCommand(
  host: EditorDetectionHost,
  command: string,
): Promise<string | undefined> {
  const pathApi = host.platform === "win32" ? path.win32 : path.posix;
  const candidates = (host.env.PATH ?? "")
    .split(pathApi.delimiter)
    .filter(Boolean)
    .map((directory) => pathApi.join(directory, command));
  return findFirst(candidates, host.isExecutable);
}

function resolveWindowsCommand(
  host: EditorDetectionHost,
  executable: string,
): Promise<string | undefined> {
  const pathApi = path.win32;
  const candidates = (host.env.PATH ?? "")
    .split(pathApi.delimiter)
    .map((directory) => directory.replace(/^"|"$/g, ""))
    .filter(Boolean)
    .map((entry) => pathApi.join(entry, executable));
  return findFirst(candidates, host.exists);
}

/**
 * Editor the OS itself would open a folder with, as a catalog id, or undefined
 * when the machine's default handler is not one of the editors pi-gui knows or
 * that editor is not installed. Every branch maps the OS's answer back to an
 * entry that is present in `editors`, so callers never get a phantom id.
 */
export async function detectDefaultEditorId(
  host: EditorDetectionHost,
  editors: readonly DetectedEditor[],
): Promise<string | undefined> {
  if (editors.length === 0) {
    return undefined;
  }
  if (host.platform === "darwin") {
    return detectMacDefaultEditor(host, editors);
  }
  if (host.platform === "win32") {
    return detectWindowsDefaultEditor(host, editors);
  }
  return detectLinuxDefaultEditor(host, editors);
}

async function detectLinuxDefaultEditor(
  host: EditorDetectionHost,
  editors: readonly DetectedEditor[],
): Promise<string | undefined> {
  const desktopId = (
    await host.runCommand("xdg-mime", ["query", "default", "inode/directory"])
  )?.trim();
  if (!desktopId) {
    return undefined;
  }
  const fileName = path.posix.basename(desktopId);
  const definition = EDITOR_CATALOG.find((entry) => entry.linuxDesktopIds?.includes(fileName));
  return definition && editors.some((editor) => editor.id === definition.id)
    ? definition.id
    : undefined;
}

async function detectMacDefaultEditor(
  host: EditorDetectionHost,
  editors: readonly DetectedEditor[],
): Promise<string | undefined> {
  const pathApi = path.posix;
  const preferencesPath = pathApi.join(
    host.homeDir,
    "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
  );
  if (!(await host.exists(preferencesPath))) {
    return undefined;
  }
  const json = await host.runCommand("plutil", ["-convert", "json", "-o", "-", preferencesPath]);
  const bundleId = json ? readMacFolderHandlerBundleId(json) : undefined;
  if (!bundleId) {
    return undefined;
  }
  // LaunchServices stores a bundle identifier, while detection records bundle
  // paths, so each detected app is read back for the id it actually carries.
  const bundleIds = await Promise.all(
    editors.map(async (editor) =>
      editor.launch.kind === "mac-app"
        ? (
            await host.runCommand("plutil", [
              "-extract",
              "CFBundleIdentifier",
              "raw",
              "-o",
              "-",
              pathApi.join(editor.launch.appPath, "Contents/Info.plist"),
            ])
          )?.trim()
        : undefined,
    ),
  );
  return editors[bundleIds.indexOf(bundleId)]?.id;
}

function readMacFolderHandlerBundleId(json: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const handlers = (parsed as { LSHandlers?: unknown }).LSHandlers;
  if (!Array.isArray(handlers)) {
    return undefined;
  }
  const folderTypes = new Set(["public.folder", "public.directory"]);
  for (const entry of handlers) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const contentType = record.LSHandlerContentType ?? record.LSContentType;
    if (typeof contentType !== "string" || !folderTypes.has(contentType)) {
      continue;
    }
    const bundleId =
      record.LSHandlerRoleAll ?? record.LSHandlerRoleViewer ?? record.LSHandlerRoleEditor;
    if (typeof bundleId === "string" && bundleId) {
      return bundleId;
    }
  }
  return undefined;
}

async function detectWindowsDefaultEditor(
  host: EditorDetectionHost,
  editors: readonly DetectedEditor[],
): Promise<string | undefined> {
  const verb =
    (await readWindowsRegistryDefault(host, "HKCU\\Software\\Classes\\Directory\\shell")) ??
    (await readWindowsRegistryDefault(host, "HKCR\\Directory\\shell"));
  if (!verb) {
    return undefined;
  }
  const command =
    (await readWindowsRegistryDefault(
      host,
      `HKCU\\Software\\Classes\\Directory\\shell\\${verb}\\command`,
    )) ?? (await readWindowsRegistryDefault(host, `HKCR\\Directory\\shell\\${verb}\\command`));
  const executable = command ? extractWindowsExecutable(command) : undefined;
  if (!executable) {
    return undefined;
  }
  const wanted = executable.toLowerCase();
  const match = editors.find(
    (editor) =>
      editor.launch.kind === "command" && editor.launch.commandPath.toLowerCase() === wanted,
  );
  return match?.id;
}

async function readWindowsRegistryDefault(
  host: EditorDetectionHost,
  key: string,
): Promise<string | undefined> {
  const output = await host.runCommand("reg", ["query", key, "/ve"]);
  if (!output) {
    return undefined;
  }
  for (const line of output.split(/\r?\n/)) {
    const match = /\sREG_(?:EXPAND_)?SZ\s+(.+)$/.exec(line);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

/** Executable path from a Windows shell command line, quoted or not. */
function extractWindowsExecutable(command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end > 1 ? trimmed.slice(1, end) : undefined;
  }
  const [executable] = trimmed.split(/\s+/);
  return executable || undefined;
}
