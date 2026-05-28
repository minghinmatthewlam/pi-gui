import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SessionCatalogSnapshot, WorkspaceCatalogSnapshot, WorkspaceId } from "@pi-gui/catalogs";
import type {
  NavigateSessionTreeOptions,
  NavigateSessionTreeResult,
  SessionQueuedMessage,
  SessionTreeSnapshot,
  CreateSessionOptions,
  HostUiResponse,
  SessionDriver,
  SessionEventListener,
  SessionModelSelection,
  SessionRef,
  SessionSnapshot,
  SessionMessageInput,
  Unsubscribe,
  WorkspaceRef,
} from "@pi-gui/session-driver/types";
import type { } from "@pi-gui/session-driver";
import {
  SessionSupervisor,
  type PiSdkDriverOptions,
  type SyncWorkspaceResult,
} from "./session-supervisor.js";
import { RuntimeSupervisor, type RuntimeSupervisorOptions } from "./runtime-supervisor.js";
import { createRuntimeDependencies } from "./runtime-deps.js";
import { generateThreadTitle, type GenerateThreadTitleOptions } from "./thread-title-generator.js";

export interface PiSdkDriverConfig extends PiSdkDriverOptions, RuntimeSupervisorOptions {}

export class PiSdkDriver implements SessionDriver {
  private readonly supervisor: SessionSupervisor;
  private readonly agentDir: string;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly generateThreadTitleOverride:
    | ((workspace: WorkspaceRef, options: GenerateThreadTitleOptions) => Promise<string | null | undefined>)
    | undefined;
  readonly runtimeSupervisor: RuntimeSupervisor;

  constructor(options: PiSdkDriverConfig = {}) {
    const deps = createRuntimeDependencies(options);
    this.agentDir = deps.agentDir;
    this.authStorage = deps.authStorage;
    this.modelRegistry = deps.modelRegistry;
    this.generateThreadTitleOverride = options.generateThreadTitleOverride;

    this.supervisor = new SessionSupervisor({ ...options, modelRegistry: deps.modelRegistry });
    this.runtimeSupervisor = new RuntimeSupervisor({ ...options, ...deps });
  }

  createSession(workspace: WorkspaceRef, options?: CreateSessionOptions): Promise<SessionSnapshot> {
    return this.supervisor.createSession(workspace, options);
  }

  openSession(sessionRef: SessionRef): Promise<SessionSnapshot> {
    return this.supervisor.openSession(sessionRef);
  }

  archiveSession(sessionRef: SessionRef): Promise<void> {
    return this.supervisor.archiveSession(sessionRef);
  }

  unarchiveSession(sessionRef: SessionRef): Promise<void> {
    return this.supervisor.unarchiveSession(sessionRef);
  }

  sendUserMessage(sessionRef: SessionRef, input: SessionMessageInput): Promise<void> {
    return this.supervisor.sendUserMessage(sessionRef, input);
  }

  replaceQueuedMessages(sessionRef: SessionRef, messages: readonly SessionQueuedMessage[]): Promise<void> {
    return this.supervisor.replaceQueuedMessages(sessionRef, messages);
  }

  cancelCurrentRun(sessionRef: SessionRef): Promise<void> {
    return this.supervisor.cancelCurrentRun(sessionRef);
  }

  setSessionModel(sessionRef: SessionRef, selection: SessionModelSelection): Promise<void> {
    return this.supervisor.setSessionModel(sessionRef, selection);
  }

  setSessionThinkingLevel(sessionRef: SessionRef, thinkingLevel: string): Promise<void> {
    return this.supervisor.setSessionThinkingLevel(sessionRef, thinkingLevel);
  }

  renameSession(sessionRef: SessionRef, title: string): Promise<void> {
    return this.supervisor.renameSession(sessionRef, title);
  }

  compactSession(sessionRef: SessionRef, customInstructions?: string): Promise<void> {
    return this.supervisor.compactSession(sessionRef, customInstructions);
  }

  reloadSession(sessionRef: SessionRef): Promise<void> {
    return this.supervisor.reloadSession(sessionRef);
  }

  getSessionTree(sessionRef: SessionRef): Promise<SessionTreeSnapshot> {
    return this.supervisor.getSessionTree(sessionRef);
  }

  navigateSessionTree(
    sessionRef: SessionRef,
    targetId: string,
    options?: NavigateSessionTreeOptions,
  ): Promise<NavigateSessionTreeResult> {
    return this.supervisor.navigateSessionTree(sessionRef, targetId, options);
  }

  getSessionCommands(sessionRef: SessionRef) {
    return this.supervisor.getSessionCommands(sessionRef);
  }

  respondToHostUiRequest(sessionRef: SessionRef, response: HostUiResponse): Promise<void> {
    return this.supervisor.respondToHostUiRequest(sessionRef, response);
  }

  subscribe(sessionRef: SessionRef, listener: SessionEventListener): Unsubscribe {
    return this.supervisor.subscribe(sessionRef, listener);
  }

  closeSession(sessionRef: SessionRef): Promise<void> {
    return this.supervisor.closeSession(sessionRef);
  }

  listWorkspaces(): Promise<WorkspaceCatalogSnapshot> {
    return this.supervisor.listWorkspaces();
  }

  listSessions(workspaceId?: WorkspaceId): Promise<SessionCatalogSnapshot> {
    return this.supervisor.listSessions(workspaceId);
  }

  syncWorkspace(path: string, displayName?: string): Promise<SyncWorkspaceResult> {
    return this.supervisor.syncWorkspace(path, displayName);
  }

  renameWorkspace(workspaceId: WorkspaceId, displayName: string) {
    return this.supervisor.renameWorkspace(workspaceId, displayName);
  }

  removeWorkspace(workspaceId: WorkspaceId): Promise<void> {
    return this.supervisor.removeWorkspace(workspaceId);
  }

  getTranscript(sessionRef: SessionRef) {
    return this.supervisor.getTranscript(sessionRef);
  }

  generateThreadTitle(workspace: WorkspaceRef, options: GenerateThreadTitleOptions): Promise<string | null> {
    if (this.generateThreadTitleOverride) {
      return Promise.resolve(this.generateThreadTitleOverride(workspace, options)).then((override) =>
        override !== undefined
          ? override
          : generateThreadTitle(workspace, options, {
              agentDir: this.agentDir,
              authStorage: this.authStorage,
              modelRegistry: this.modelRegistry,
            }),
      );
    }
    return generateThreadTitle(workspace, options, {
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
    });
  }
}

export function createPiSdkDriver(options?: PiSdkDriverConfig): PiSdkDriver {
  return new PiSdkDriver(options);
}
