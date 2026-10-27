import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { DesktopEditorDescriptor, DesktopEditorList } from "../../../../contracts/editors";
import type { PiDesktopApi } from "../../../../contracts/ipc";

interface UseOpenInEditorParams {
  readonly api: PiDesktopApi | undefined;
  readonly workspaceId: string | undefined;
  readonly onOpenFolder: () => void;
}

export interface OpenInEditorState {
  readonly editors: readonly DesktopEditorDescriptor[];
  readonly preferredEditorId: string | undefined;
  readonly menuOpen: boolean;
  readonly busy: boolean;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly targetLabel: string | undefined;
  /** Catalog id of the editor the main button opens; undefined while probing. */
  readonly targetEditorId: string | undefined;
  readonly wrapRef: RefObject<HTMLDivElement | null>;
  readonly toggleMenu: () => void;
  readonly openIn: () => void;
  /** Changes the main button's target without launching anything. */
  readonly selectEditor: (editorId: string) => void;
}

/**
 * Owns the split button's editor list, its menu, and the open request. The
 * list comes from main, so this never decides on its own which IDEs exist.
 */
export function useOpenInEditor(params: UseOpenInEditorParams): OpenInEditorState {
  const { api, workspaceId, onOpenFolder } = params;
  const [list, setList] = useState<DesktopEditorList>({ editors: [] });
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!api) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    void api
      .listEditors()
      .then((next) => {
        if (!cancelled) {
          setList(next);
        }
      })
      .catch((cause: unknown) => {
        console.error("[renderer] listEditors failed", cause);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && !(wrapRef.current?.contains(target) ?? false)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  const toggleMenu = useCallback(() => {
    // Opening the menu is the start of a new attempt, so a previous failure
    // stops being reported here.
    setError(undefined);
    setMenuOpen((current) => !current);
  }, []);

  const openIn = useCallback(() => {
    if (!api || !workspaceId || busy || loading) {
      return;
    }
    setError(undefined);
    const target = list.preferredEditorId ?? list.editors[0]?.id;
    if (!target) {
      setMenuOpen(false);
      onOpenFolder();
      return;
    }
    setBusy(true);
    void api
      .openWorkspaceInEditor(workspaceId, target)
      .then((next) => {
        setList(next);
        setMenuOpen(false);
      })
      .catch((cause: unknown) => {
        console.error("[renderer] openWorkspaceInEditor failed", cause);
        setError("Could not open that editor. Try another one.");
        // Keep the menu open so the failure is visible, and re-request the
        // list because main just dropped its cache after the failed launch.
        setMenuOpen(true);
        void api
          .listEditors()
          .then((refreshed) => {
            setList(refreshed);
          })
          .catch((refreshCause: unknown) => {
            console.error("[renderer] listEditors refresh failed", refreshCause);
          });
      })
      .finally(() => {
        setBusy(false);
      });
  }, [api, busy, list.editors, list.preferredEditorId, loading, onOpenFolder, workspaceId]);

  /**
   * Chooses which editor the main button targets. Selection never launches:
   * only the main button opens anything.
   */
  const selectEditor = useCallback(
    (editorId: string) => {
      if (!api || busy || loading) {
        return;
      }
      setError(undefined);
      setBusy(true);
      void api
        .setPreferredEditor(editorId)
        .then((next) => {
          setList(next);
          setMenuOpen(false);
        })
        .catch((cause: unknown) => {
          console.error("[renderer] setPreferredEditor failed", cause);
          // Keep the menu open so the failure is visible, and re-request the
          // list in case main re-probed and the editor is gone.
          setError("Could not select that editor. Try another one.");
          void api
            .listEditors()
            .then((refreshed) => {
              setList(refreshed);
            })
            .catch((refreshCause: unknown) => {
              console.error("[renderer] listEditors refresh failed", refreshCause);
            });
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [api, busy, loading],
  );

  const preferred =
    list.editors.find((editor) => editor.id === list.preferredEditorId) ?? list.editors[0];

  return {
    editors: list.editors,
    preferredEditorId: list.preferredEditorId,
    menuOpen,
    busy,
    loading,
    error,
    targetLabel: preferred?.shortLabel,
    targetEditorId: preferred?.id,
    wrapRef,
    toggleMenu,
    openIn,
    selectEditor,
  };
}
