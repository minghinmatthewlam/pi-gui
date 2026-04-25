import type { WebContents } from "electron";
import { createRequire } from "node:module";
import { accessSync, chmodSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type {
  TerminalPanelSnapshot,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
  TerminalSize,
} from "../src/ipc";
import { desktopIpc } from "../src/ipc";
import { appendTerminalReplay } from "../src/terminal-model";

type NodePty = typeof import("node-pty");
type IPty = import("node-pty").IPty;
type IDisposable = import("node-pty").IDisposable;

const require = createRequire(__filename);
let nodePty: NodePty | undefined;

const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 80, rows: 24 };
const MAX_WRITE_LENGTH = 128 * 1024;
const MAX_TERMINAL_SESSIONS_PER_ROOT = 8;

interface TerminalRoot {
  readonly rootKey: string;
  readonly workspaceId: string;
  activeSessionId: string | undefined;
  readonly sessionIds: string[];
}

interface TerminalSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly rootKey: string;
  readonly cwd: string;
  readonly ownerWebContentsId: number;
  shell: string;
  title: string;
  status: TerminalSessionStatus;
  replay: string;
  truncated: boolean;
  exitCode: number | undefined;
  signal: number | undefined;
  size: TerminalSize;
  pty: IPty | undefined;
  dataSubscription: IDisposable | undefined;
  exitSubscription: IDisposable | undefined;
}

export interface TerminalServiceOptions {
  readonly getWorkspacePath: (workspaceId: string) => string | undefined;
  readonly getIntegratedTerminalShell: () => string | undefined;
  readonly isPackaged: boolean;
}

export class TerminalService {
  private readonly rootsByKey = new Map<string, TerminalRoot>();
  private readonly sessionsById = new Map<string, TerminalSession>();
  private nextSessionNumber = 1;

  constructor(private readonly options: TerminalServiceOptions) {}

  ensurePanel(webContents: WebContents, workspaceId: string, size?: Partial<TerminalSize>): TerminalPanelSnapshot {
    const root = this.ensureRoot(workspaceId);
    if (!root.activeSessionId || root.sessionIds.length === 0) {
      const session = this.createSessionForRoot(webContents, root, size);
      root.sessionIds.push(session.id);
      root.activeSessionId = session.id;
    }
    return this.snapshotRoot(root);
  }

  createSession(webContents: WebContents, workspaceId: string, size?: Partial<TerminalSize>): TerminalPanelSnapshot {
    const root = this.ensureRoot(workspaceId);
    if (root.sessionIds.length >= MAX_TERMINAL_SESSIONS_PER_ROOT) {
      throw new Error(`A workspace can have up to ${MAX_TERMINAL_SESSIONS_PER_ROOT} terminal tabs.`);
    }
    const session = this.createSessionForRoot(webContents, root, size);
    root.sessionIds.push(session.id);
    root.activeSessionId = session.id;
    return this.snapshotRoot(root);
  }

  setActiveSession(webContents: WebContents, workspaceId: string, terminalId: string): TerminalPanelSnapshot {
    const session = this.requireOwnedSession(webContents, terminalId);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Terminal session ${terminalId} does not belong to workspace ${workspaceId}`);
    }
    const root = this.requireRoot(session.rootKey);
    if (!root.sessionIds.includes(terminalId)) {
      throw new Error(`Unknown terminal session: ${terminalId}`);
    }
    root.activeSessionId = terminalId;
    return this.snapshotRoot(root);
  }

  write(webContents: WebContents, terminalId: string, data: string): void {
    const session = this.requireOwnedSession(webContents, terminalId);
    if (typeof data !== "string" || data.length === 0 || data.length > MAX_WRITE_LENGTH) {
      return;
    }
    session.pty?.write(data);
  }

  resize(webContents: WebContents, terminalId: string, size: TerminalSize): void {
    const session = this.requireOwnedSession(webContents, terminalId);
    const normalizedSize = normalizeSize(size);
    session.size = normalizedSize;
    session.pty?.resize(normalizedSize.cols, normalizedSize.rows);
  }

  restart(webContents: WebContents, terminalId: string, size?: Partial<TerminalSize>): TerminalPanelSnapshot {
    const session = this.requireOwnedSession(webContents, terminalId);
    this.disposePty(session);
    session.shell = this.resolveShell();
    session.title = this.defaultTitle(session);
    session.status = "running";
    session.replay = "";
    session.truncated = false;
    session.exitCode = undefined;
    session.signal = undefined;
    session.size = normalizeSize(size ?? session.size);
    this.spawnPty(webContents, session);
    return this.snapshotRoot(this.requireRoot(session.rootKey));
  }

  close(webContents: WebContents, terminalId: string): TerminalPanelSnapshot | null {
    const session = this.requireOwnedSession(webContents, terminalId);
    const root = this.requireRoot(session.rootKey);
    this.disposeSession(session);
    this.sessionsById.delete(session.id);

    const index = root.sessionIds.indexOf(session.id);
    if (index >= 0) {
      root.sessionIds.splice(index, 1);
    }

    if (root.sessionIds.length === 0) {
      this.rootsByKey.delete(root.rootKey);
      return null;
    }

    if (root.activeSessionId === session.id) {
      const nextIndex = Math.min(index, root.sessionIds.length - 1);
      root.activeSessionId = root.sessionIds[nextIndex];
    }
    return this.snapshotRoot(root);
  }

  setTitle(webContents: WebContents, terminalId: string, title: string): void {
    const session = this.requireOwnedSession(webContents, terminalId);
    const normalizedTitle = title.trim();
    session.title = normalizedTitle.length > 0 ? normalizedTitle.slice(0, 80) : this.defaultTitle(session);
  }

  retainWorkspacePaths(workspacePaths: readonly string[]): void {
    const retained = new Set(workspacePaths.map((workspacePath) => normalizeRootKey(workspacePath)));
    for (const [rootKey, root] of this.rootsByKey) {
      if (!retained.has(rootKey)) {
        for (const sessionId of root.sessionIds) {
          const session = this.sessionsById.get(sessionId);
          if (session) {
            this.disposeSession(session);
            this.sessionsById.delete(session.id);
          }
        }
        this.rootsByKey.delete(rootKey);
      }
    }
  }

  dispose(): void {
    for (const session of this.sessionsById.values()) {
      this.disposeSession(session);
    }
    this.sessionsById.clear();
    this.rootsByKey.clear();
  }

  private ensureRoot(workspaceId: string): TerminalRoot {
    const workspacePath = this.options.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    ensureDirectory(workspacePath);
    const rootKey = normalizeRootKey(workspacePath);
    const existingRoot = this.rootsByKey.get(rootKey);
    if (existingRoot) {
      return existingRoot;
    }
    const root: TerminalRoot = {
      rootKey,
      workspaceId,
      activeSessionId: undefined,
      sessionIds: [],
    };
    this.rootsByKey.set(rootKey, root);
    return root;
  }

  private createSessionForRoot(
    webContents: WebContents,
    root: TerminalRoot,
    size?: Partial<TerminalSize>,
  ): TerminalSession {
    const session: TerminalSession = {
      id: `terminal-${Date.now().toString(36)}-${this.nextSessionNumber++}`,
      workspaceId: root.workspaceId,
      rootKey: root.rootKey,
      cwd: root.rootKey,
      ownerWebContentsId: webContents.id,
      shell: this.resolveShell(),
      title: "",
      status: "running",
      replay: "",
      truncated: false,
      exitCode: undefined,
      signal: undefined,
      size: normalizeSize(size),
      pty: undefined,
      dataSubscription: undefined,
      exitSubscription: undefined,
    };
    session.title = this.defaultTitle(session);
    this.sessionsById.set(session.id, session);
    this.spawnPty(webContents, session);
    return session;
  }

  private spawnPty(webContents: WebContents, session: TerminalSession): void {
    try {
      ensureNodePtySpawnHelperExecutable(this.options.isPackaged);
      session.pty = loadNodePty().spawn(session.shell, [], {
        name: "xterm-256color",
        cols: session.size.cols,
        rows: session.size.rows,
        cwd: session.cwd,
        env: buildTerminalEnv(),
      });
    } catch (error) {
      session.status = "error";
      const message = error instanceof Error ? error.message : String(error);
      this.appendReplay(session, `${message}\r\n`);
      this.sendToOwner(webContents, session, desktopIpc.terminalError, { terminalId: session.id, message });
      return;
    }

    session.dataSubscription = session.pty.onData((data) => {
      this.appendReplay(session, data);
      this.sendToOwner(webContents, session, desktopIpc.terminalData, { terminalId: session.id, data });
    });
    session.exitSubscription = session.pty.onExit(({ exitCode, signal }) => {
      session.status = "exited";
      session.exitCode = exitCode;
      session.signal = signal;
      this.sendToOwner(webContents, session, desktopIpc.terminalExit, {
        terminalId: session.id,
        exitCode,
        signal,
      });
    });
  }

  private appendReplay(session: TerminalSession, data: string): void {
    const nextReplay = appendTerminalReplay(session.replay, data, session.truncated);
    session.replay = nextReplay.replay;
    session.truncated = nextReplay.truncated;
  }

  private sendToOwner(webContents: WebContents, session: TerminalSession, channel: string, payload: unknown): void {
    if (webContents.id === session.ownerWebContentsId && !webContents.isDestroyed()) {
      webContents.send(channel, payload);
    }
  }

  private requireOwnedSession(webContents: WebContents, terminalId: string): TerminalSession {
    const session = this.sessionsById.get(terminalId);
    if (!session || session.ownerWebContentsId !== webContents.id) {
      throw new Error(`Unknown terminal session: ${terminalId}`);
    }
    return session;
  }

  private requireRoot(rootKey: string): TerminalRoot {
    const root = this.rootsByKey.get(rootKey);
    if (!root) {
      throw new Error(`Unknown terminal root: ${rootKey}`);
    }
    return root;
  }

  private snapshotRoot(root: TerminalRoot): TerminalPanelSnapshot {
    const sessions = root.sessionIds
      .map((sessionId) => this.sessionsById.get(sessionId))
      .filter((session): session is TerminalSession => Boolean(session));
    const activeSessionId = root.activeSessionId && sessions.some((session) => session.id === root.activeSessionId)
      ? root.activeSessionId
      : sessions[0]?.id ?? "";
    return {
      workspaceId: root.workspaceId,
      rootKey: root.rootKey,
      activeSessionId,
      sessions: sessions.map((session) => this.snapshotSession(session)),
    };
  }

  private snapshotSession(session: TerminalSession): TerminalSessionSnapshot {
    return {
      id: session.id,
      workspaceId: session.workspaceId,
      cwd: session.cwd,
      shell: session.shell,
      title: session.title,
      status: session.status,
      replay: session.replay,
      truncated: session.truncated,
      exitCode: session.exitCode,
      signal: session.signal,
    };
  }

  private disposeSession(session: TerminalSession): void {
    this.disposePty(session);
  }

  private disposePty(session: TerminalSession): void {
    const pty = session.pty;
    session.dataSubscription?.dispose();
    session.exitSubscription?.dispose();
    session.dataSubscription = undefined;
    session.exitSubscription = undefined;
    if (pty && process.platform !== "win32") {
      killUnixProcessGroup(pty.pid);
    }
    try {
      pty?.kill();
    } catch {
      // Best-effort cleanup when the child process has already exited.
    }
    session.pty = undefined;
  }

  private defaultTitle(session: TerminalSession): string {
    return `Terminal ${session.id.split("-").at(-1) ?? ""}`.trim();
  }

  private resolveShell(): string {
    const configuredShell = this.options.getIntegratedTerminalShell()?.trim();
    const shellPath = configuredShell || process.env.SHELL || defaultShellForPlatform();
    if (process.platform !== "win32" && !path.isAbsolute(shellPath)) {
      throw new Error(`Integrated terminal shell must be an absolute path: ${shellPath}`);
    }
    ensureExecutable(shellPath);
    return shellPath;
  }
}

function normalizeSize(size?: Partial<TerminalSize>): TerminalSize {
  return {
    cols: clampInteger(size?.cols, DEFAULT_TERMINAL_SIZE.cols, 10, 500),
    rows: clampInteger(size?.rows, DEFAULT_TERMINAL_SIZE.rows, 4, 200),
  };
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value as number)));
}

function normalizeRootKey(workspacePath: string): string {
  try {
    return realpathSync.native(workspacePath);
  } catch {
    return path.resolve(workspacePath);
  }
}

function ensureDirectory(directoryPath: string): void {
  const stats = statSync(directoryPath);
  if (!stats.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${directoryPath}`);
  }
}

function ensureExecutable(shellPath: string): void {
  if (process.platform === "win32") {
    return;
  }
  accessSync(shellPath, constants.X_OK);
}

function defaultShellForPlatform(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec || "cmd.exe";
  }
  if (process.platform === "darwin") {
    return "/bin/zsh";
  }
  return "/bin/bash";
}

function buildTerminalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.TERM = "xterm-256color";
  delete env.TERMINFO;
  delete env.TERMINFO_DIRS;
  return env;
}

function ensureNodePtySpawnHelperExecutable(isPackaged: boolean): void {
  if (process.platform === "win32") {
    return;
  }
  const packageDir = path.dirname(require.resolve("node-pty/package.json"));
  const helperPath = resolveNodePtySpawnHelperPath(packageDir);
  if (!helperPath) {
    return;
  }
  try {
    accessSync(helperPath, constants.X_OK);
  } catch (error) {
    if (isPackaged) {
      throw error;
    }
    chmodSync(helperPath, 0o755);
  }
}

function loadNodePty(): NodePty {
  nodePty ??= require("node-pty") as NodePty;
  return nodePty;
}

function killUnixProcessGroup(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, "SIGHUP");
    return;
  } catch {
    // Fall back to the direct child when the process is not a group leader.
  }
  try {
    process.kill(pid, "SIGHUP");
  } catch {
    // Best-effort cleanup; the process may already be gone.
  }
}

function resolveNodePtySpawnHelperPath(packageDir: string): string | undefined {
  const candidateDirs = [
    path.join(packageDir, "build", "Release"),
    path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`),
  ];
  for (const candidateDir of candidateDirs) {
    const ptyNodePath = path.join(candidateDir, "pty.node");
    const helperPath = path.join(candidateDir, "spawn-helper");
    if (existsSync(ptyNodePath) && existsSync(helperPath)) {
      return helperPath;
    }
  }
  return undefined;
}
