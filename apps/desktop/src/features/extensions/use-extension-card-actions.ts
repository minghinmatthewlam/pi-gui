import { useCallback, useRef, type RefObject } from "react";
import type { ExtensionAction, SessionRef } from "@pi-gui/session-driver";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type { RunExtensionAction } from "../conversation/extension-card";
import type { WorkspaceFileLine } from "../conversation/workspace-file-line";

/**
 * Sends a card button's action to main, which checks and runs it, then applies what main
 * hands back: open the checked file, or add text to the composer. Failures show as a toast
 * from main. A result that arrives after the user switched threads is dropped.
 */
export function useExtensionCardActions({
  api,
  target,
  openWorkspaceFileLine,
  composerDraftRef,
  setComposerDraft,
}: {
  readonly api: PiDesktopApi | undefined;
  readonly target: SessionRef | null;
  readonly openWorkspaceFileLine: (target: WorkspaceFileLine) => void;
  readonly composerDraftRef: RefObject<string>;
  readonly setComposerDraft: (draft: string) => void;
}): RunExtensionAction {
  const targetRef = useRef(target);
  targetRef.current = target;
  return useCallback(
    (action: ExtensionAction) => {
      const clickedTarget = targetRef.current;
      if (!api || !clickedTarget) return;
      void api
        .runExtensionAction(action)
        .then((effect) => {
          if (!effect || targetRef.current !== clickedTarget) return;
          if (effect.kind === "openFile") {
            const line = effect.line ?? 1;
            openWorkspaceFileLine({ path: effect.path, line, endLine: line });
            return;
          }
          const draft = composerDraftRef.current ?? "";
          setComposerDraft(draft.trim() ? `${draft.replace(/\s+$/, "")}\n${effect.text}` : effect.text);
          document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')?.focus();
        })
        .catch((error: unknown) => {
          console.error("[renderer] extension card action failed", error);
        });
    },
    [api, openWorkspaceFileLine, composerDraftRef, setComposerDraft],
  );
}
