import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { WindowOwner } from "../windows/window-owner";

export interface MainFrameRequest {
  readonly event: IpcMainInvokeEvent;
  readonly window: BrowserWindow;
  readonly contents: WebContents;
}

export type MainFrameHandler = <Input, Result>(
  channel: string,
  decode: (raw: unknown) => Input,
  handler: (input: Input, request: MainFrameRequest) => Result,
) => void;

/**
 * Registers invoke handlers that accept only an owned window's main frame.
 * Extension iframes share that window's webContents, so `event.sender` alone
 * does not identify the app renderer. A missing `senderFrame` (navigated or
 * destroyed frame) is rejected. The sender is checked before `decode` runs.
 */
export function mainFrameHandler(windows: Pick<WindowOwner, "windowForSender">): MainFrameHandler {
  return (channel, decode, handler) => {
    ipcMain.handle(channel, (event, raw: unknown) => {
      const window = windows.windowForSender(event.sender);
      const contents = window.webContents;
      if (!event.senderFrame || event.senderFrame !== contents.mainFrame) {
        throw new Error(`${channel} must originate from the window's main frame.`);
      }
      return handler(decode(raw), { event, window, contents });
    });
  };
}
