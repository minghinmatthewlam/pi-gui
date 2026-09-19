import type { AppView, ComposerDraftSyncSource } from "../../contracts/desktop-state";

/** Options accepted by the application state projector. */
export interface RefreshStateOptions {
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly composerDraft?: string;
  readonly composerDraftSyncSource?: ComposerDraftSyncSource;
  readonly clearLastError?: boolean;
  readonly refreshWorktrees?: boolean;
  readonly activeView?: AppView;
  readonly markSelectedSessionViewed?: boolean;
  readonly hydrateSelectedSession?: boolean;
  readonly emitState?: boolean;
  readonly persistState?: boolean;
  readonly publishSelectedTranscript?: boolean;
}
