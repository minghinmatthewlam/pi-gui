import { expect, test } from "@playwright/test";
import type { Dispatch, SetStateAction } from "react";
import { updateSnapshot } from "../../src/app/desktop-app-state";
import { createEmptyDesktopAppState, type DesktopAppState } from "../../src/desktop-state";

function stateHarness(initial: DesktopAppState) {
  let state: DesktopAppState | null = initial;
  const setState: Dispatch<SetStateAction<DesktopAppState | null>> = (update) => {
    state = typeof update === "function" ? update(state) : update;
  };
  return { setState, read: () => state };
}

test("failed snapshot actions preserve the draft and reject before success handlers run", async () => {
  const initial = { ...createEmptyDesktopAppState(), revision: 7, composerDraft: "unsent draft" };
  const state = stateHarness(initial);
  const failure = new Error("Session unavailable");
  let ranSuccessHandler = false;
  const action = updateSnapshot(state.setState, () => Promise.reject(failure)).then(() => {
    ranSuccessHandler = true;
  });

  await expect(action).rejects.toBe(failure);
  expect(ranSuccessHandler).toBe(false);
  expect(state.read()).toEqual({ ...initial, lastError: "Session unavailable" });
});

test("successful actions apply fresh snapshots without replacing newer pushed state", async () => {
  const initial = { ...createEmptyDesktopAppState(), revision: 7, composerDraft: "initial" };
  const state = stateHarness(initial);
  const fresh = { ...initial, revision: 8, composerDraft: "saved" };
  await expect(updateSnapshot(state.setState, () => Promise.resolve(fresh))).resolves.toBe(fresh);
  expect(state.read()).toBe(fresh);

  const pushed = { ...fresh, revision: 10, composerDraft: "newer pushed draft" };
  state.setState(pushed);
  const stale = { ...fresh, revision: 9, composerDraft: "stale response" };
  await updateSnapshot(state.setState, () => Promise.resolve(stale));
  expect(state.read()).toBe(pushed);
});
