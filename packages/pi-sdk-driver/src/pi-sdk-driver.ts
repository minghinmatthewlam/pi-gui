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
import type { RuntimeLoginCallbacks, RuntimeSnapshot } from "@pi-app/session-driver/runtime-types";
import {
  SessionSupervisor,
  type PiSdkDriverOptions,
  type SyncWorkspaceResult,
} from "./session-supervisor.js";
import { RuntimeSupervisor, type RuntimeSupervisorOptions } from "./runtime-supervisor.js";

export interface PiSdkDriverConfig extends PiSdkDriverOptions, RuntimeSupervisorOptions {}

export class PiSdkDriver implements SessionDriver {
  private readonly supervisor: SessionSupervisor;
  private readonly runtimeSupervisor: RuntimeSupervisor;

  constructor(options: PiSdkDriverConfig = {}) {
    this.supervisor = new SessionSupervisor(options);
    this.runtimeSupervisor = new RuntimeSupervisor(options);
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

  renameSession(sessionRef: SessionRef, title: string): Promise<void> {
    return this.supervisor.renameSession(sessionRef, title);
  }

  compactSession(sessionRef: SessionRef, customInstructions?: string): Promise<void> {
    return this.supervisor.compactSession(sessionRef, customInstructions);
  }

  reloadSession(sessionRef: SessionRef): Promise<void> {
    return this.supervisor.reloadSession(sessionRef);
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

  getRuntimeSnapshot(workspace: WorkspaceRef): Promise<RuntimeSnapshot> {
    return this.runtimeSupervisor.getRuntimeSnapshot(workspace);
  }

  refreshRuntime(workspace: WorkspaceRef): Promise<RuntimeSnapshot> {
    return this.runtimeSupervisor.refreshRuntime(workspace);
  }

  login(workspace: WorkspaceRef, providerId: string, callbacks: RuntimeLoginCallbacks): Promise<RuntimeSnapshot> {
    return this.runtimeSupervisor.login(workspace, providerId, callbacks);
  }

  logout(workspace: WorkspaceRef, providerId: string): Promise<RuntimeSnapshot> {
    return this.runtimeSupervisor.logout(workspace, providerId);
  }

  setDefaultModel(
    workspace: WorkspaceRef,
    selection: {
      readonly provider: string;
      readonly modelId: string;
    },
  ): Promise<RuntimeSnapshot> {
    return this.runtimeSupervisor.setDefaultModel(workspace, selection);
  }

  setDefaultThinkingLevel(
    workspace: WorkspaceRef,
    thinkingLevel: RuntimeSnapshot["settings"]["defaultThinkingLevel"],
  ): Promise<RuntimeSnapshot> {
    return this.runtimeSupervisor.setDefaultThinkingLevel(workspace, thinkingLevel);
  }

  setEnableSkillCommands(workspace: WorkspaceRef, enabled: boolean): Promise<RuntimeSnapshot> {
    return this.runtimeSupervisor.setEnableSkillCommands(workspace, enabled);
  }

  setScopedModelPatterns(workspace: WorkspaceRef, patterns: readonly string[]): Promise<RuntimeSnapshot> {
    return this.runtimeSupervisor.setScopedModelPatterns(workspace, patterns);
  }

  setSkillEnabled(workspace: WorkspaceRef, filePath: string, enabled: boolean): Promise<RuntimeSnapshot> {
    return this.runtimeSupervisor.setSkillEnabled(workspace, filePath, enabled);
  }
}

export function createPiSdkDriver(options?: PiSdkDriverConfig): PiSdkDriver {
  return new PiSdkDriver(options);
}
