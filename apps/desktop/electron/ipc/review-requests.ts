import { desktopIpc } from "../../contracts/ipc";
import {
  decodeTurnChangesInput,
  decodeGetReviewInput,
  decodeReviewFileInput,
  decodeSetReviewFileReviewedInput,
  decodeChangeReviewFileStageInput,
} from "../../contracts/review";
import type { ReviewOwner } from "../workbench/review-owner";
import type { MainFrameHandler } from "./main-frame-ipc";

export type ReviewRequestsOwner = Pick<
  ReviewOwner,
  | "getTurnChanges"
  | "getReview"
  | "getReviewFile"
  | "setReviewFileReviewed"
  | "changeReviewFileStage"
>;

export function registerReviewRequests(handle: MainFrameHandler, owner: ReviewRequestsOwner): void {
  handle(desktopIpc.getTurnChanges, decodeTurnChangesInput, (input) => owner.getTurnChanges(input));
  handle(desktopIpc.getReview, decodeGetReviewInput, (input) => owner.getReview(input));
  handle(desktopIpc.getReviewFile, decodeReviewFileInput, (input) => owner.getReviewFile(input));
  handle(desktopIpc.setReviewFileReviewed, decodeSetReviewFileReviewedInput, (input) =>
    owner.setReviewFileReviewed(input),
  );
  handle(desktopIpc.changeReviewFileStage, decodeChangeReviewFileStageInput, (input) =>
    owner.changeReviewFileStage(input),
  );
}
