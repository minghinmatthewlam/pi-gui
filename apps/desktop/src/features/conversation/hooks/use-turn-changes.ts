import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type { PiDesktopApi } from "../../../../contracts/ipc";
import type { TurnChangeSummary } from "../../../../contracts/review";
import type { useWorkbench } from "../../workbench/use-workbench";

const NO_TURNS: readonly TurnChangeSummary[] = [];

/**
 * The files each captured turn of the selected thread changed. Captures finish when a run
 * settles, so the list is read when the thread opens (running or not) and again when a run
 * starts or stops; the open turn of a running thread is never listed.
 */
export function useTurnChanges({
  api,
  target,
  running,
  workbench,
}: {
  readonly api: PiDesktopApi | undefined;
  readonly target: SessionRef | null;
  readonly running: boolean;
  readonly workbench: Pick<ReturnType<typeof useWorkbench>, "setChanges" | "openTool">;
}) {
  const [loaded, setLoaded] = useState<{
    readonly target: SessionRef;
    readonly turns: readonly TurnChangeSummary[];
  } | null>(null);
  const workbenchRef = useRef(workbench);
  workbenchRef.current = workbench;

  useEffect(() => {
    if (!api || !target) return;
    let current = true;
    void api.getTurnChanges({ target }).then(
      (result) => {
        if (current && result.state === "available") setLoaded({ target, turns: result.turns });
      },
      () => undefined, // The timeline stays usable without cards; the Changes panel reports errors.
    );
    return () => {
      current = false;
    };
  }, [api, target, running]);

  const openTurnChange = useCallback((turn: TurnChangeSummary, path: string) => {
    workbenchRef.current.setChanges({
      workspaceId: turn.checkoutId,
      selectedPath: path,
      scope: { kind: "turn", checkpointId: turn.checkpointId },
    });
    workbenchRef.current.openTool({ kind: "changes" });
  }, []);

  return {
    turns: loaded && target && sameTarget(loaded.target, target) ? loaded.turns : NO_TURNS,
    openTurnChange,
  };
}

function sameTarget(left: SessionRef, right: SessionRef): boolean {
  return left.workspaceId === right.workspaceId && left.sessionId === right.sessionId;
}
