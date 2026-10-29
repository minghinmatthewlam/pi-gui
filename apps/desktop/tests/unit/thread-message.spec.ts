import { expect, test } from "@playwright/test";
import {
  formatCrossProjectMessage,
  parseCrossProjectMessage,
} from "../../contracts/thread-message";

test("reads back the project and thread a cross-project message came from", () => {
  const origin = { project: 'odd "name"\nwith a line', threadId: "ws-1:session-1" };
  const text = formatCrossProjectMessage(origin, "Run the checks.\n\nThen report.");
  expect(parseCrossProjectMessage(text)).toEqual({
    ...origin,
    body: "Run the checks.\n\nThen report.",
  });
});

test("ordinary messages carry no project origin", () => {
  expect(parseCrossProjectMessage("Run the checks.")).toBeNull();
  expect(parseCrossProjectMessage('[Message from project "x"]\n\nhello')).toBeNull();
  expect(
    parseCrossProjectMessage('Quote: [Message from project "a" in thread "b"]\n\nhi'),
  ).toBeNull();
});
