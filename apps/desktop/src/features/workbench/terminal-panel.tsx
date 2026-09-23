import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { WorkspaceRecord } from "../../../contracts/desktop-state";
import { CloseIcon, PlusIcon, RefreshIcon } from "../../ui/icons";
import type {
  TerminalPanelSnapshot,
  TerminalSessionSnapshot,
  TerminalSize,
} from "../../../contracts/ipc";
import { appendTerminalReplay } from "../../../contracts/terminal-model";

interface TerminalPanelProps {
  readonly workspace: WorkspaceRecord;
  readonly sessionId: string;
  readonly onHide: () => void;
}

export function TerminalPanel({ workspace, sessionId, onHide }: TerminalPanelProps) {
  const api = window.piApp;
  const panelRef = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const activeTerminalIdRef = useRef("");
  const mountedRef = useRef(false);
  const lastSizeRef = useRef<TerminalSize>({ cols: 80, rows: 24 });
  const [panel, setPanel] = useState<TerminalPanelSnapshot | null>(null);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const activeSession = useMemo(
    () => panel?.sessions.find((session) => session.id === panel.activeSessionId),
    [panel],
  );

  const requestPanel = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      const nextPanel = await api.ensureTerminalPanel(workspace.id, sessionId, lastSizeRef.current);
      setPanel(nextPanel);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api, sessionId, workspace.id]);

  useEffect(() => {
    setPanel(null);
    setError("");
    void requestPanel().catch((error: unknown) => {
      setError(error instanceof Error ? error.message : String(error));
    });
  }, [requestPanel]);

  const createTerminal = useCallback(async () => {
    if (!api) {
      return;
    }
    const nextPanel = await api.createTerminalSession(workspace.id, sessionId, lastSizeRef.current);
    setPanel(nextPanel);
  }, [api, sessionId, workspace.id]);

  const setActiveTerminal = useCallback(
    async (terminalId: string) => {
      if (!api) {
        return;
      }
      const nextPanel = await api.setActiveTerminalSession(workspace.id, sessionId, terminalId);
      setPanel(nextPanel);
    },
    [api, sessionId, workspace.id],
  );

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      if (!api) {
        return;
      }
      const nextPanel = await api.closeTerminalSession(terminalId);
      if (nextPanel) {
        setPanel(nextPanel);
      } else {
        setPanel(null);
        // Closing a shell may finish after its task or tool view was left.
        // Never let that old view close the newly selected task's Terminal tab.
        if (mountedRef.current) onHide();
      }
    },
    [api, onHide],
  );

  const restartTerminal = useCallback(async () => {
    if (!api || !activeSession) {
      return;
    }
    const nextPanel = await api.restartTerminalSession(activeSession.id, lastSizeRef.current);
    terminalRef.current?.reset();
    setPanel(nextPanel);
  }, [activeSession, api]);

  const fitAndResize = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const terminalId = activeTerminalIdRef.current;
    if (!api || !terminalId || !terminal || !fitAddon || !containerRef.current) {
      return;
    }
    fitAddon.fit();
    const nextSize = { cols: terminal.cols, rows: terminal.rows };
    if (nextSize.cols === lastSizeRef.current.cols && nextSize.rows === lastSizeRef.current.rows) {
      return;
    }
    lastSizeRef.current = nextSize;
    void api.resizeTerminal(terminalId, nextSize).catch((error: unknown) => {
      setError(error instanceof Error ? error.message : String(error));
    });
  }, [api]);

  useEffect(() => {
    const panelElement = panelRef.current;
    if (!api || !panelElement) {
      return undefined;
    }
    const markFocused = () => {
      void api.setTerminalFocused(true).catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error));
      });
    };
    const markBlurred = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && panelElement.contains(event.relatedTarget)) {
        return;
      }
      void api.setTerminalFocused(false).catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error));
      });
    };
    panelElement.addEventListener("focusin", markFocused);
    panelElement.addEventListener("focusout", markBlurred);
    return () => {
      panelElement.removeEventListener("focusin", markFocused);
      panelElement.removeEventListener("focusout", markBlurred);
      void api.setTerminalFocused(false).catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error));
      });
    };
  }, [api]);

  useEffect(() => {
    if (!api) {
      return undefined;
    }
    const removeData = api.onTerminalData((event) => {
      setPanel((currentPanel) =>
        updateSession(currentPanel, event.terminalId, (session) => ({
          ...session,
          ...appendTerminalReplay(session.replay, event.data, session.truncated),
        })),
      );
      if (event.terminalId === activeTerminalIdRef.current) {
        terminalRef.current?.write(event.data);
      }
    });
    const removeExit = api.onTerminalExit((event) => {
      setPanel((currentPanel) =>
        updateSession(currentPanel, event.terminalId, (session) => ({
          ...session,
          status: "exited",
          exitCode: event.exitCode,
          signal: event.signal,
        })),
      );
    });
    const removeError = api.onTerminalError((event) => {
      setPanel((currentPanel) =>
        updateSession(currentPanel, event.terminalId, (session) => ({
          ...session,
          status: "error",
          ...appendTerminalReplay(session.replay, `${event.message}\r\n`, session.truncated),
        })),
      );
    });
    return () => {
      removeData();
      removeExit();
      removeError();
    };
  }, [api]);

  useEffect(() => {
    const container = containerRef.current;
    if (!api || !container || !activeSession) {
      return undefined;
    }

    activeTerminalIdRef.current = activeSession.id;
    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      fontFamily: "Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      fontSize: 12,
      scrollback: 2_000,
      theme: {
        background: "#0f1117",
        foreground: "#d7dae0",
        cursor: "#f2f4f8",
        selectionBackground: "#39557a",
      },
    });
    const fitAddon = new FitAddon();
    const clipboardAddon = new ClipboardAddon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      void api.openExternal(uri).catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error));
      });
    });

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(clipboardAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") {
        return true;
      }
      const commandModifier = api.platform === "darwin" ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      if (commandModifier && !event.shiftKey && key === "t") {
        void createTerminal().catch((error: unknown) => {
          setError(error instanceof Error ? error.message : String(error));
        });
        return false;
      }
      if (api.platform !== "darwin" && event.ctrlKey && !event.metaKey && !event.altKey) {
        // Hand these chords back to the browser instead of letting xterm turn them into
        // control characters: paste (Ctrl+V on Windows, Ctrl+Shift+V on Linux, where
        // shells keep Ctrl+V) and Ctrl+J, which App's window listener routes to the terminal
        // toggle. Match the typed letter, not the physical key, so other layouts keep theirs.
        const pasteChord = api.platform === "win32" ? !event.shiftKey : event.shiftKey;
        if ((key === "v" && pasteChord) || (key === "j" && !event.shiftKey)) {
          return false;
        }
      }
      if (api.platform === "darwin" && event.metaKey) {
        const sequence = macTerminalSequenceForEvent(event);
        if (sequence) {
          void api.writeTerminal(activeSession.id, sequence).catch((error: unknown) => {
            setError(error instanceof Error ? error.message : String(error));
          });
          return false;
        }
      }
      return true;
    });
    terminal.onData((data) => {
      void api.writeTerminal(activeSession.id, data).catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error));
      });
    });
    terminal.onTitleChange((title) => {
      void api.setTerminalTitle(activeSession.id, title).catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error));
      });
      setPanel((currentPanel) =>
        updateSession(currentPanel, activeSession.id, (session) => ({
          ...session,
          title: title.trim() || session.title,
        })),
      );
    });
    terminal.open(container);
    if (activeSession.replay) {
      terminal.write(activeSession.replay);
    }
    terminal.focus();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    window.requestAnimationFrame(fitAndResize);

    const resizeObserver = new ResizeObserver(() => fitAndResize());
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      fitAddonRef.current = null;
      terminalRef.current = null;
      activeTerminalIdRef.current = "";
      terminal.dispose();
    };
  }, [activeSession?.id, api, createTerminal, fitAndResize]);

  return (
    <section
      ref={panelRef}
      className="terminal-panel"
      data-pi-terminal="true"
      data-testid="integrated-terminal"
    >
      <div className="terminal-panel__toolbar">
        <div className="terminal-panel__tabs" role="tablist" aria-label="Terminal sessions">
          {(panel?.sessions ?? []).map((session) => (
            <div
              key={session.id}
              className={`terminal-panel__tab-item${session.id === panel?.activeSessionId ? " terminal-panel__tab-item--active" : ""}`}
            >
              <button
                className="terminal-panel__tab"
                type="button"
                role="tab"
                aria-selected={session.id === panel?.activeSessionId}
                data-testid="terminal-tab"
                onClick={() =>
                  void setActiveTerminal(session.id).catch((error: unknown) => {
                    setError(error instanceof Error ? error.message : String(error));
                  })
                }
              >
                <span
                  className={`terminal-panel__status terminal-panel__status--${session.status}`}
                />
                <span className="terminal-panel__tab-title">{session.title}</span>
              </button>
              <button
                type="button"
                className="terminal-panel__tab-close"
                aria-label={`Close ${session.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void closeTerminal(session.id).catch((error: unknown) => {
                    setError(error instanceof Error ? error.message : String(error));
                  });
                }}
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-panel__actions">
          <button
            type="button"
            className="icon-button terminal-panel__action"
            title="New terminal"
            aria-label="New terminal"
            onClick={() =>
              void createTerminal().catch((error: unknown) => {
                setError(error instanceof Error ? error.message : String(error));
              })
            }
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            className="icon-button terminal-panel__action"
            title="Restart terminal"
            aria-label="Restart terminal"
            onClick={() =>
              void restartTerminal().catch((error: unknown) => {
                setError(error instanceof Error ? error.message : String(error));
              })
            }
          >
            <RefreshIcon />
          </button>
        </div>
      </div>
      {error ? (
        <div className="terminal-panel__error">{error}</div>
      ) : (
        <div className="terminal-panel__viewport" ref={containerRef} />
      )}
    </section>
  );
}

function updateSession(
  panel: TerminalPanelSnapshot | null,
  terminalId: string,
  update: (session: TerminalSessionSnapshot) => TerminalSessionSnapshot,
): TerminalPanelSnapshot | null {
  if (!panel) {
    return panel;
  }
  return {
    ...panel,
    sessions: panel.sessions.map((session) =>
      session.id === terminalId ? update(session) : session,
    ),
  };
}

function macTerminalSequenceForEvent(event: KeyboardEvent): string | undefined {
  switch (event.key) {
    case "ArrowLeft":
    case "ArrowUp":
      return "\x01";
    case "ArrowRight":
    case "ArrowDown":
      return "\x05";
    case "Backspace":
      return "\x15";
    case "Delete":
      return "\x0b";
    default:
      return undefined;
  }
}
