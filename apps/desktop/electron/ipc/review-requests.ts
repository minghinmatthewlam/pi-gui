import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { desktopIpc } from "../../contracts/ipc";
import {
  decodeResolveTurnReviewInput,
  decodeGetReviewInput,
  decodeReviewFileInput,
  decodeSetReviewFileReviewedInput,
  decodeChangeReviewFileStageInput,
} from "../../contracts/review";
import type { ReviewOwner } from "../workbench/review-owner";
import type { WindowOwner } from "../windows/window-owner";

export type ReviewRequestsOwner = Pick<
  ReviewOwner,
  | "resolveTurnReview"
  | "getReview"
  | "getReviewFile"
  | "setReviewFileReviewed"
  | "changeReviewFileStage"
>;

export function registerReviewRequests(windows: WindowOwner, owner: ReviewRequestsOwner): void {
  const validateSender = (event: IpcMainInvokeEvent) => {
    const sender = windows.windowForSender(event.sender).webContents;
    if (!event.senderFrame || event.senderFrame !== sender.mainFrame) {
      throw new Error("Review requests must originate from the window's main frame.");
    }
  };
  ipcMain.handle(desktopIpc.resolveTurnReview, (event, raw: unknown) => {
    validateSender(event);
    return owner.resolveTurnReview(decodeResolveTurnReviewInput(raw));
  });
  ipcMain.handle(desktopIpc.getReview, (event, raw: unknown) => {
    validateSender(event);
    return owner.getReview(decodeGetReviewInput(raw));
  });
  ipcMain.handle(desktopIpc.getReviewFile, (event, raw: unknown) => {
    validateSender(event);
    return owner.getReviewFile(decodeReviewFileInput(raw));
  });
  ipcMain.handle(desktopIpc.setReviewFileReviewed, (event, raw: unknown) => {
    validateSender(event);
    return owner.setReviewFileReviewed(decodeSetReviewFileReviewedInput(raw));
  });
  ipcMain.handle(desktopIpc.changeReviewFileStage, (event, raw: unknown) => {
    validateSender(event);
    return owner.changeReviewFileStage(decodeChangeReviewFileStageInput(raw));
  });
}
