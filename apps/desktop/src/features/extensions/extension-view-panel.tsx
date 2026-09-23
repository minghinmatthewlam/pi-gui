import { useEffect, useRef, useState } from "react";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type {
  DesktopExtensionViewInfo,
  ExtensionViewConnection,
  ExtensionViewMessage,
} from "../../../contracts/extension-views";
import { RefreshIcon } from "../../ui/icons";

export interface ExtensionViewTheme {
  readonly mode: "light" | "dark";
  readonly background: string;
  readonly foreground: string;
  readonly accent: string;
}

type ViewState =
  | { readonly kind: "opening" }
  | { readonly kind: "mounting" | "ready"; readonly connection: ExtensionViewConnection }
  | { readonly kind: "failed"; readonly message: string };

const MAX_BUFFERED_MESSAGES = 128;
const FRAME_READY_TIMEOUT_MS = 10_000;

export function ExtensionViewPanel({
  api,
  target,
  view,
  theme,
  onBeforePrepareTaskDraft,
  onPrepareTaskDraftPendingChange,
}: {
  readonly api: PiDesktopApi;
  readonly target: SessionRef;
  readonly view: DesktopExtensionViewInfo;
  readonly theme: ExtensionViewTheme;
  readonly onBeforePrepareTaskDraft: () => Promise<void>;
  readonly onPrepareTaskDraftPendingChange: (pending: boolean, requestKey: string) => void;
}) {
  const [state, setState] = useState<ViewState>({ kind: "opening" });
  const [reloadNonce, setReloadNonce] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const attachFrameRef = useRef<((frame: HTMLIFrameElement) => void) | null>(null);
  const portRef = useRef<MessagePort | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const beforePrepareTaskDraftRef = useRef(onBeforePrepareTaskDraft);
  beforePrepareTaskDraftRef.current = onBeforePrepareTaskDraft;
  const prepareTaskDraftPendingChangeRef = useRef(onPrepareTaskDraftPendingChange);
  prepareTaskDraftPendingChangeRef.current = onPrepareTaskDraftPendingChange;
  const scopeKey = JSON.stringify([
    target.workspaceId,
    target.sessionId,
    view.extensionId,
    view.id,
    view.generation,
    view.state,
    reloadNonce,
  ]);
  const currentScopeKeyRef = useRef(scopeKey);
  currentScopeKeyRef.current = scopeKey;

  useEffect(() => {
    let disposed = false;
    let connection: ExtensionViewConnection | null = null;
    let channel: MessageChannel | null = null;
    let readyTimer: number | undefined;
    let unsubscribe: (() => void) | undefined;
    const beforeOpen: ExtensionViewMessage[] = [];
    const beforeMount: unknown[] = [];
    let preparingTaskDraft = false;
    let forwardedPrepareTaskDraft = false;
    let prepareRequestKey = "";
    const notifyPreparePending = prepareTaskDraftPendingChangeRef.current;
    const releasePreparePending = () => {
      if (!preparingTaskDraft) return;
      preparingTaskDraft = false;
      notifyPreparePending(false, prepareRequestKey);
    };
    setState({ kind: "opening" });
    const isCurrentMount = () => !disposed && currentScopeKeyRef.current === scopeKey;

    const closeOwner = (id: string) => {
      void api.closeExtensionView(id).catch((error: unknown) => {
        console.error("[extension-view] close failed", error);
      });
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      // Closing the view cancels preflight, but cannot undo a host action that is already
      // creating a task. Its request keeps the original composer locked until it settles.
      if (!forwardedPrepareTaskDraft) releasePreparePending();
      if (readyTimer !== undefined) window.clearTimeout(readyTimer);
      unsubscribe?.();
      beforeOpen.length = 0;
      beforeMount.length = 0;
      if (channel) {
        try {
          channel.port1.postMessage({ type: "closed", reason: "View closed" });
        } catch {
          /* Already disconnected. */
        }
        channel.port1.onmessage = null;
        channel.port1.onmessageerror = null;
        channel.port1.close();
        channel.port2.close();
        if (portRef.current === channel.port1) portRef.current = null;
      }
      if (connection) closeOwner(connection.connectionId);
    };
    const fail = (message: string) => {
      if (disposed) return;
      setState({ kind: "failed", message });
      dispose();
    };
    const deliver = (message: unknown) => {
      if (disposed) return;
      if (channel) channel.port1.postMessage(message);
      else if (beforeMount.length < MAX_BUFFERED_MESSAGES) beforeMount.push(message);
      else
        fail(
          "The extension sent too many messages before its view was ready. Reload the view to reconnect.",
        );
    };

    const attachFrame = (frame: HTMLIFrameElement) => {
      if (disposed || !connection || !frame.contentWindow) return;
      if (channel) {
        fail("The extension frame reloaded. Reload the view to reconnect.");
        return;
      }
      const opened = connection;
      channel = new MessageChannel();
      portRef.current = channel.port1;
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        if (!isCurrentMount()) return;
        const message = event.data;
        if (isFrameMessage(message, "pi-gui:frame-ready")) {
          if (readyTimer !== undefined) window.clearTimeout(readyTimer);
          setState({ kind: "ready", connection: opened });
          return;
        }
        if (isFrameMessage(message, "pi-gui:frame-error")) {
          fail(
            typeof message.message === "string"
              ? message.message.slice(0, 4096)
              : "The extension view could not start.",
          );
          return;
        }
        const forward = async () => {
          if (isPrepareTaskDraftMessage(message)) {
            if (preparingTaskDraft) {
              channel?.port1.postMessage({
                type: "host-action-result",
                requestId: message.requestId,
                ok: false,
                error: "A task draft is already being prepared.",
              });
              return;
            }
            preparingTaskDraft = true;
            prepareRequestKey = JSON.stringify([opened.connectionId, message.requestId]);
            notifyPreparePending(true, prepareRequestKey);
            try {
              await beforePrepareTaskDraftRef.current();
              if (!isCurrentMount()) return;
              forwardedPrepareTaskDraft = true;
              await api.sendExtensionViewMessage({ connectionId: opened.connectionId, message });
            } catch (error) {
              if (isCurrentMount())
                channel?.port1.postMessage({
                  type: "host-action-result",
                  requestId: message.requestId,
                  ok: false,
                  error: error instanceof Error ? error.message : "The draft could not be saved.",
                });
            } finally {
              forwardedPrepareTaskDraft = false;
              releasePreparePending();
            }
            return;
          }
          if (!isCurrentMount()) return;
          await api.sendExtensionViewMessage({ connectionId: opened.connectionId, message });
        };
        void forward().catch((error: unknown) => {
          if (isCurrentMount()) fail(error instanceof Error ? error.message : String(error));
        });
      };
      channel.port1.onmessageerror = () =>
        fail("The extension sent a message that could not be read.");
      channel.port1.start();
      // An opaque-origin frame requires '*'; the target is this exact iframe window and the
      // transferred capability is a dedicated port, never a broadcast window-message channel.
      frame.contentWindow.postMessage(
        {
          type: "pi-gui:extension-connect",
          connectionId: opened.connectionId,
          theme: themeRef.current,
        },
        "*",
        [channel.port2],
      );
      for (const message of beforeMount.splice(0)) channel.port1.postMessage(message);
    };
    attachFrameRef.current = attachFrame;

    if (view.state === "error") {
      fail(view.error ?? "This extension view is unavailable.");
      return dispose;
    }
    unsubscribe = api.onExtensionViewMessage((event) => {
      if (disposed) return;
      if (!connection) {
        if (beforeOpen.length < MAX_BUFFERED_MESSAGES) beforeOpen.push(event);
        else
          fail("Too many extension messages arrived while opening the view. Reload to reconnect.");
      } else if (event.connectionId === connection.connectionId) deliver(event.message);
    });
    void api
      .openExtensionView({
        target: { workspaceId: target.workspaceId, sessionId: target.sessionId },
        extensionId: view.extensionId,
        viewId: view.id,
      })
      .then(
        (opened) => {
          if (disposed) {
            closeOwner(opened.connectionId);
            return;
          }
          connection = opened;
          for (const event of beforeOpen.splice(0)) {
            if (event.connectionId === opened.connectionId) deliver(event.message);
          }
          if (disposed) return;
          setState({ kind: "mounting", connection: opened });
          readyTimer = window.setTimeout(
            () => fail("The extension view did not finish loading. Reload it to try again."),
            FRAME_READY_TIMEOUT_MS,
          );
        },
        (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
      );
    return () => {
      if (attachFrameRef.current === attachFrame) attachFrameRef.current = null;
      dispose();
    };
  }, [
    api,
    scopeKey,
    reloadNonce,
    target.sessionId,
    target.workspaceId,
    view.extensionId,
    view.generation,
    view.id,
    view.state,
    view.error,
  ]);

  useEffect(() => {
    portRef.current?.postMessage({ type: "pi-gui:theme-changed", theme });
  }, [theme.mode, theme.background, theme.foreground, theme.accent]);

  const connection = state.kind === "mounting" || state.kind === "ready" ? state.connection : null;
  return (
    <section
      className="extension-view-panel"
      aria-label={view.title}
      data-testid="extension-view-panel"
      data-state={state.kind}
    >
      <header className="extension-view-panel__header">
        <span>{view.title}</span>
        <button
          className="button"
          type="button"
          onClick={() => setReloadNonce((value) => value + 1)}
        >
          <RefreshIcon />
          Reload view
        </button>
      </header>
      {state.kind === "failed" ? (
        <div className="extension-view-panel__status" role="status">
          <h3>Couldn’t open this view</h3>
          <p>{state.message}</p>
          <p>The extension’s commands remain available. Reload view reconnects its interface.</p>
        </div>
      ) : null}
      <div className="extension-view-panel__body">
        {state.kind === "opening" || state.kind === "mounting" ? (
          // Covers the frame while it mounts, so the frame keeps its place when the view becomes ready.
          <div className="extension-view-panel__status extension-view-panel__loading" role="status">
            Loading extension view…
          </div>
        ) : null}
        {connection ? (
          <iframe
            className="extension-view-panel__frame"
            data-testid="extension-view-frame"
            key={connection.connectionId}
            title={view.title}
            ref={iframeRef}
            src={connection.frameUrl}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            onLoad={() => {
              const frame = iframeRef.current;
              if (frame) attachFrameRef.current?.(frame);
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

function isFrameMessage(
  value: unknown,
  type: string,
): value is { readonly type: string; readonly message?: unknown } {
  return value !== null && typeof value === "object" && "type" in value && value.type === type;
}

function isPrepareTaskDraftMessage(value: unknown): value is { readonly requestId: string } {
  return (
    isFrameMessage(value, "host-action") &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    "action" in value &&
    isFrameMessage(value.action, "prepareTaskDraft")
  );
}
