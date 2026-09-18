import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { SessionTreeSnapshot } from "@pi-gui/session-driver/types";
import {
  type AppView,
  type DesktopAppState,
  type ForkThreadInput,
  type NewThreadEnvironment,
  type SessionRecord,
  type WorkspaceRecord,
} from "../desktop-state";
import { applySnapshotIfNewer } from "../app/desktop-app-state";
import type { PiDesktopApi } from "../ipc";
import { resolveRepoWorkspaceId } from "../workspace-roots";

interface TreeModalState {
  readonly open: boolean;
  readonly loading: boolean;
  readonly submitting: boolean;
  readonly tree?: SessionTreeSnapshot;
  readonly error?: string;
}

interface ForkModalState {
  readonly open: boolean;
  readonly submitting: boolean;
  readonly sourceMessageIndex: number;
  readonly messagePreview?: string;
  readonly error?: string;
}

interface UseTreeForkModalsParams {
  readonly api: PiDesktopApi | undefined;
  readonly snapshot: DesktopAppState | null;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly selectedSessionKey: string;
  readonly rootWorkspace: WorkspaceRecord | undefined;
  readonly activeView: AppView | undefined;
  readonly setComposerDraft: Dispatch<SetStateAction<string>>;
  readonly focusComposer: () => void;
}

export function useTreeForkModals(params: UseTreeForkModalsParams) {
  const {
    api,
    snapshot,
    setSnapshot,
    selectedWorkspace,
    selectedSession,
    selectedSessionKey,
    rootWorkspace,
    activeView,
    setComposerDraft,
    focusComposer,
  } = params;

  const [treeModalState, setTreeModalState] = useState<TreeModalState>({
    open: false,
    loading: false,
    submitting: false,
  });
  const [forkModalState, setForkModalState] = useState<ForkModalState>({
    open: false,
    submitting: false,
    sourceMessageIndex: -1,
  });

  const closeTreeModal = useCallback(() => {
    setTreeModalState((current) =>
      current.submitting
        ? current
        : {
            open: false,
            loading: false,
            submitting: false,
          },
    );
    focusComposer();
  }, [focusComposer]);

  const openTreeModal = useCallback(() => {
    if (!api || !selectedWorkspace || !selectedSession) {
      return;
    }

    setTreeModalState({
      open: true,
      loading: true,
      submitting: false,
    });
    setComposerDraft("");

    void api
      .getSessionTree({
        workspaceId: selectedWorkspace.id,
        sessionId: selectedSession.id,
      })
      .then((tree) => {
        setTreeModalState({
          open: true,
          loading: false,
          submitting: false,
          tree,
        });
      })
      .catch((error) => {
        setTreeModalState({
          open: true,
          loading: false,
          submitting: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [api, selectedSession, selectedWorkspace, setComposerDraft]);

  const navigateTreeSelection = useCallback(
    (
      targetId: string,
      options?: { readonly summarize?: boolean; readonly customInstructions?: string },
    ) => {
      if (!api || !selectedWorkspace || !selectedSession) {
        return;
      }

      setTreeModalState((current) => ({ ...current, submitting: true, error: undefined }));
      void api
        .navigateSessionTree(
          {
            workspaceId: selectedWorkspace.id,
            sessionId: selectedSession.id,
          },
          targetId,
          options,
        )
        .then(({ state, result }) => {
          applySnapshotIfNewer(setSnapshot, state);
          setTreeModalState({
            open: false,
            loading: false,
            submitting: false,
          });
          setComposerDraft((current) =>
            !current.trim() && result.editorText ? result.editorText : state.composerDraft,
          );
          focusComposer();
        })
        .catch((error) => {
          setTreeModalState((current) => ({
            ...current,
            submitting: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        });
    },
    [api, selectedSession, selectedWorkspace, setSnapshot, setComposerDraft, focusComposer],
  );

  const closeForkModal = useCallback(() => {
    setForkModalState((current) =>
      current.submitting
        ? current
        : {
            open: false,
            submitting: false,
            sourceMessageIndex: -1,
          },
    );
  }, []);

  const openForkModal = useCallback(
    (sourceMessageIndex: number, preview?: string) => {
      if (!api || !selectedWorkspace || !selectedSession) {
        return;
      }
      const trimmed = preview?.trim();
      setForkModalState({
        open: true,
        submitting: false,
        sourceMessageIndex,
        messagePreview: trimmed ? trimmed.slice(0, 280) : undefined,
      });
    },
    [api, selectedSession, selectedWorkspace],
  );

  const handleForkSubmit = useCallback(
    (environment: NewThreadEnvironment) => {
      if (!api || !selectedWorkspace || !selectedSession) {
        return;
      }
      const rootWorkspaceId =
        (snapshot
          ? resolveRepoWorkspaceId(snapshot.workspaces, selectedWorkspace.id)
          : undefined) ?? selectedWorkspace.id;
      const input: ForkThreadInput = {
        sourceWorkspaceId: selectedWorkspace.id,
        sourceSessionId: selectedSession.id,
        rootWorkspaceId,
        environment,
        sourceMessageIndex: forkModalState.sourceMessageIndex,
        position: "after",
      };
      setForkModalState((current) => ({ ...current, submitting: true, error: undefined }));
      void api
        .forkThread(input)
        .then((state) => {
          applySnapshotIfNewer(setSnapshot, state);
          setForkModalState({
            open: false,
            submitting: false,
            sourceMessageIndex: -1,
          });
          focusComposer();
        })
        .catch((error) => {
          setForkModalState((current) => ({
            ...current,
            submitting: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        });
    },
    [
      api,
      forkModalState.sourceMessageIndex,
      selectedSession,
      selectedWorkspace,
      snapshot,
      setSnapshot,
      focusComposer,
    ],
  );

  useEffect(() => {
    setTreeModalState((current) =>
      current.open
        ? {
            open: false,
            loading: false,
            submitting: false,
          }
        : current,
    );
  }, [selectedSessionKey, activeView]);

  return {
    treeModalState,
    forkModalState,
    closeTreeModal,
    openTreeModal,
    navigateTreeSelection,
    closeForkModal,
    openForkModal,
    handleForkSubmit,
    canUseWorktree: Boolean(rootWorkspace),
  };
}
