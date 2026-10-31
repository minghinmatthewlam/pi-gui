import { expect, test } from "@playwright/test";
import { NavigationHistory } from "./navigation-history";

const alpha = { view: "threads", workspaceId: "a", sessionId: "one" } as const;
const beta = { view: "threads", workspaceId: "b", sessionId: "two" } as const;
const settings = { view: "settings", workspaceId: "a", section: "models" } as const;
const available = () => true;

test("moves both ways across projects and settings without recording repeat visits", () => {
  const history = new NavigationHistory();
  expect(history.move(-1, available)).toBeUndefined();
  history.record(alpha);
  history.record(alpha);
  history.record(beta);
  history.record(settings);
  expect(history.move(-1, available)).toEqual(beta);
  expect(history.move(-1, available)).toEqual(alpha);
  expect(history.move(-1, available)).toBeUndefined();
  expect(history.move(1, available)).toEqual(beta);
  expect(history.move(1, available)).toEqual(settings);
  expect(history.move(1, available)).toBeUndefined();
});

test("discards forward history when a different destination opens", () => {
  const history = new NavigationHistory();
  history.record(alpha);
  history.record(beta);
  history.move(-1, available);
  history.record(settings);
  expect(history.move(1, available)).toBeUndefined();
  expect(history.move(-1, available)).toEqual(alpha);
});

test("skips unavailable destinations in both directions", () => {
  const history = new NavigationHistory();
  history.record(alpha);
  history.record(beta);
  history.record(settings);
  expect(history.move(-1, (location) => location.sessionId !== "two")).toEqual(alpha);
  expect(history.move(1, (location) => location.sessionId !== "two")).toEqual(settings);
});

test("bounds history while retaining the latest destinations", () => {
  const history = new NavigationHistory();
  for (let i = 0; i < 250; i++) history.record({ ...alpha, sessionId: String(i) });
  for (let i = 248; i >= 50; i--) expect(history.move(-1, available)?.sessionId).toBe(String(i));
  expect(history.move(-1, available)).toBeUndefined();
});

test("recognizes repeat locations regardless of property order", () => {
  const history = new NavigationHistory();
  history.record(alpha);
  history.record({ sessionId: alpha.sessionId, workspaceId: alpha.workspaceId, view: alpha.view });
  expect(history.move(-1, available)).toBeUndefined();
});
