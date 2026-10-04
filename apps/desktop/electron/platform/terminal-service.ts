import { webContents as allWebContents, type WebContents } from "electron";
import type {
  TerminalDataEvent,
  TerminalErrorEvent,
  TerminalExitEvent,
  TerminalPanelSnapshot,
  TerminalSize,
} from "../../contracts/ipc";
import { desktopIpc } from "../../contracts/ipc";
import { coreMethods, coreNotifications } from "../../core-process/protocol";
import type { RpcPeer } from "../../rpc/rpc-peer";

export interface TerminalServiceOptions {
  /** The Rust core, which runs the shells (`crates/pi-gui-core/src/terminal`). */
  readonly core: RpcPeer;
  readonly getWorkspacePath: (workspaceId: string) => string | undefined;
  readonly getIntegratedTerminalShell: () => string | undefined;
}

/**
 * The integrated terminal as main sees it: each call names the window that owns the shell,
 * and the core's output, exit and error notifications go to that window only.
 */
export class TerminalService {
  constructor(private readonly options: TerminalServiceOptions) {
    const forward =
      <T>(channel: string) =>
      (params: unknown) => {
        const { ownerId, ...payload } = params as { ownerId: number } & T;
        const owner = allWebContents.fromId(ownerId);
        if (owner && !owner.isDestroyed()) {
          owner.send(channel, payload);
        }
      };
    options.core.onNotification(
      coreNotifications.terminalData,
      forward<TerminalDataEvent>(desktopIpc.terminalData),
    );
    options.core.onNotification(
      coreNotifications.terminalExit,
      forward<TerminalExitEvent>(desktopIpc.terminalExit),
    );
    options.core.onNotification(
      coreNotifications.terminalError,
      forward<TerminalErrorEvent>(desktopIpc.terminalError),
    );
  }

  ensurePanel(
    webContents: WebContents,
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot> {
    return this.panelCall(
      coreMethods.terminalEnsurePanel,
      webContents,
      workspaceId,
      terminalScopeId,
      size,
    );
  }

  createSession(
    webContents: WebContents,
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot> {
    return this.panelCall(
      coreMethods.terminalCreateSession,
      webContents,
      workspaceId,
      terminalScopeId,
      size,
    );
  }

  setActiveSession(
    webContents: WebContents,
    workspaceId: string,
    terminalScopeId: string,
    terminalId: string,
  ): Promise<TerminalPanelSnapshot> {
    return this.request(coreMethods.terminalSetActiveSession, {
      ownerId: webContents.id,
      workspaceId,
      terminalScopeId,
      terminalId,
    }) as Promise<TerminalPanelSnapshot>;
  }

  async write(webContents: WebContents, terminalId: string, data: string): Promise<void> {
    await this.request(coreMethods.terminalWrite, { ownerId: webContents.id, terminalId, data });
  }

  async resize(webContents: WebContents, terminalId: string, size: TerminalSize): Promise<void> {
    await this.request(coreMethods.terminalResize, { ownerId: webContents.id, terminalId, size });
  }

  restart(
    webContents: WebContents,
    terminalId: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot> {
    return this.request(coreMethods.terminalRestart, {
      ownerId: webContents.id,
      terminalId,
      size,
      shell: this.options.getIntegratedTerminalShell(),
    }) as Promise<TerminalPanelSnapshot>;
  }

  close(webContents: WebContents, terminalId: string): Promise<TerminalPanelSnapshot | null> {
    return this.request(coreMethods.terminalClose, {
      ownerId: webContents.id,
      terminalId,
    }) as Promise<TerminalPanelSnapshot | null>;
  }

  async setTitle(webContents: WebContents, terminalId: string, title: string): Promise<void> {
    await this.request(coreMethods.terminalSetTitle, {
      ownerId: webContents.id,
      terminalId,
      title,
    });
  }

  /** Hangs up the shells of folders that are no longer open. */
  retainWorkspacePaths(workspacePaths: readonly string[]): void {
    this.background(coreMethods.terminalRetainWorkspacePaths, { workspacePaths });
  }

  disposeWebContents(webContentsId: number): void {
    this.background(coreMethods.terminalDisposeOwner, { ownerId: webContentsId });
  }

  dispose(): void {
    this.background(coreMethods.terminalDisposeAll, {});
  }

  private panelCall(
    method: string,
    webContents: WebContents,
    workspaceId: string,
    terminalScopeId: string,
    size: Partial<TerminalSize> | undefined,
  ): Promise<TerminalPanelSnapshot> {
    return this.request(method, {
      ownerId: webContents.id,
      workspaceId,
      workspacePath: this.options.getWorkspacePath(workspaceId) ?? null,
      terminalScopeId,
      size,
      shell: this.options.getIntegratedTerminalShell(),
    }) as Promise<TerminalPanelSnapshot>;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return this.options.core.request(method, params);
  }

  /** Cleanup nobody waits for; once the core is gone its shells are gone too. */
  private background(method: string, params: unknown): void {
    if (this.options.core.closed) return;
    this.request(method, params).catch((error: unknown) => {
      console.error(`[terminal] ${method} failed`, error);
    });
  }
}
