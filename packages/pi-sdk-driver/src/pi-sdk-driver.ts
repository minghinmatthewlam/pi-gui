import type { SessionCatalogSnapshot, WorkspaceCatalogSnapshot, WorkspaceId } from "@pi-app/catalogs";
import type {
  CreateSessionOptions,
  SessionDriver,
  SessionEventListener,
  SessionModelSelection,
  SessionRef,
  SessionSnapshot,
  SessionMessageInput,
  Unsubscribe,
  WorkspaceRef,
} from "@pi-app/session-driver";
import {
  SessionSupervisor,
  type PiSdkDriverOptions,
  type SyncWorkspaceResult,
} from "./session-supervisor.js";

export interface PiSdkDriverConfig extends PiSdkDriverOptions {}

export class PiSdkDriver implements SessionDriver {
  private readonly supervisor: SessionSupervisor;

  constructor(options: PiSdkDriverConfig = {}) {
    this.supervisor = new SessionSupervisor(options);
  }

  createSession(workspace: WorkspaceRef, options?: CreateSessionOptions): Promise<SessionSnapshot> {
    return this.supervisor.createSession(workspace, options);
  }

  openSession(sessionRef: SessionRef): Promise<SessionSnapshot> {
    return this.supervisor.openSession(sessionRef);
  }

  sendUserMessage(sessionRef: SessionRef, input: SessionMessageInput): Promise<void> {
    return this.supervisor.sendUserMessage(sessionRef, input);
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

  getTranscript(sessionRef: SessionRef) {
    return this.supervisor.getTranscript(sessionRef);
  }
}

export function createPiSdkDriver(options?: PiSdkDriverConfig): PiSdkDriver {
  return new PiSdkDriver(options);
}
