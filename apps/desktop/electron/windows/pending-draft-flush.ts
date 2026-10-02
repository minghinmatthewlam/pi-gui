import type { BrowserWindow, WebContents } from "electron";
import { desktopIpc } from "../../contracts/ipc";

interface WaitingFlush {
  readonly contents: WebContents;
  readonly done: () => void;
}

/**
 * Asks renderers to send their debounced composer drafts before their window goes away.
 * Each request resolves when the window's main frame acknowledges it after its draft
 * writes settled, or when the window dies or the bound elapses, so shutdown never waits
 * on an unresponsive renderer.
 */
export class PendingComposerDraftFlusher {
  private nextRequestId = 1;
  private readonly waiting = new Map<number, WaitingFlush>();

  constructor(private readonly timeoutMs: number) {}

  flush(windows: readonly BrowserWindow[]): Promise<void> {
    return Promise.all(windows.map((window) => this.flushWindow(window))).then(() => undefined);
  }

  /** Called for the owning window's main frame only, through the main-frame IPC helper. */
  acknowledge(contents: WebContents, requestId: number): void {
    const entry = this.waiting.get(requestId);
    if (entry?.contents === contents) entry.done();
  }

  private flushWindow(window: BrowserWindow): Promise<void> {
    if (window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isCrashed())
      return Promise.resolve();
    const contents = window.webContents;
    const requestId = this.nextRequestId++;
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        contents.off("destroyed", done);
        contents.off("render-process-gone", done);
        this.waiting.delete(requestId);
        resolve();
      };
      const timer = setTimeout(() => {
        console.warn("pi-gui: a window did not save its composer draft in time.");
        done();
      }, this.timeoutMs);
      contents.once("destroyed", done);
      contents.once("render-process-gone", done);
      this.waiting.set(requestId, { contents, done });
      contents.send(desktopIpc.flushPendingComposerDraft, requestId);
    });
  }
}
