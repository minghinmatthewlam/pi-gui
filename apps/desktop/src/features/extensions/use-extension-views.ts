import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type { DesktopExtensionViewInfo } from "../../../contracts/extension-views";

interface ExtensionViewCatalog {
  readonly targetKey: string;
  readonly views: readonly DesktopExtensionViewInfo[];
  readonly loading: boolean;
  readonly error: string;
}

export function useExtensionViews({
  api,
  target,
}: {
  readonly api: PiDesktopApi | undefined;
  readonly target: SessionRef | null;
}) {
  const [catalog, setCatalog] = useState<ExtensionViewCatalog | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const reload = useCallback(() => setReloadNonce((value) => value + 1), []);
  const latest = useRef(catalog);
  latest.current = catalog;
  const workspaceId = target?.workspaceId;
  const sessionId = target?.sessionId;
  const targetKey = JSON.stringify([workspaceId, sessionId]);

  useEffect(() => {
    if (!api || !workspaceId || !sessionId) return;
    let disposed = false;
    let receivedPush = false;
    const previous = latest.current;
    setCatalog({
      targetKey,
      views: previous?.targetKey === targetKey ? previous.views : [],
      loading: true,
      error: "",
    });
    // Subscribe before the initial list. A catalog replacement is newer than that in-flight read.
    const unsubscribe = api.onExtensionViewCatalogChanged((event) => {
      if (
        disposed ||
        event.target.workspaceId !== workspaceId ||
        event.target.sessionId !== sessionId
      )
        return;
      receivedPush = true;
      setCatalog({ targetKey, views: event.views, loading: false, error: "" });
    });
    void api.listExtensionViews({ workspaceId, sessionId }).then(
      (views) => {
        if (!disposed && !receivedPush) setCatalog({ targetKey, views, loading: false, error: "" });
      },
      (error: unknown) => {
        if (!disposed && !receivedPush)
          setCatalog({
            targetKey,
            views: previous?.targetKey === targetKey ? previous.views : [],
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [api, reloadNonce, sessionId, targetKey, workspaceId]);

  const current = catalog?.targetKey === targetKey ? catalog : null;
  return {
    views: current?.views ?? [],
    loading: Boolean(target) && (!current || current.loading),
    error: current?.error ?? "",
    reload,
  };
}
