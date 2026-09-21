import { expect, test } from "@playwright/test";
import { shouldAdoptComposerSnapshot } from "../../src/features/conversation/hooks/use-composer-draft-sync";

test("adopts every snapshot when no local edit is pending", () => {
  expect(shouldAdoptComposerSnapshot("persist", false)).toBe(true);
  expect(shouldAdoptComposerSnapshot("state", false)).toBe(true);
  expect(shouldAdoptComposerSnapshot("command", false)).toBe(true);
  expect(shouldAdoptComposerSnapshot("extension-editor-text", false)).toBe(true);
  expect(shouldAdoptComposerSnapshot("queued-message-edit", false)).toBe(true);
  expect(shouldAdoptComposerSnapshot("selection", false)).toBe(true);
});

test("keeps a newer local edit over persist, state, and command restores", () => {
  expect(shouldAdoptComposerSnapshot("persist", true)).toBe(false);
  expect(shouldAdoptComposerSnapshot("state", true)).toBe(false);
  expect(shouldAdoptComposerSnapshot("command", true)).toBe(false);
});

test("still applies explicit replacements while a local edit is pending", () => {
  expect(shouldAdoptComposerSnapshot("extension-editor-text", true)).toBe(true);
  expect(shouldAdoptComposerSnapshot("queued-message-edit", true)).toBe(true);
  expect(shouldAdoptComposerSnapshot("selection", true)).toBe(true);
});
