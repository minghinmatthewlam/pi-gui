import { expect, test } from "@playwright/test";
import { getZoomActionFromShortcut, type DesktopShortcutInput } from "../../contracts/ipc";

function chord(overrides: Partial<DesktopShortcutInput>): DesktopShortcutInput {
  return { modifier: true, shift: false, key: "", code: "", ...overrides };
}

test("plus, equals and the keypad zoom in", () => {
  expect(getZoomActionFromShortcut(chord({ key: "=", code: "Equal" }))).toBe("in");
  expect(getZoomActionFromShortcut(chord({ key: "+", code: "Equal", shift: true }))).toBe("in");
  expect(getZoomActionFromShortcut(chord({ key: "Unidentified", code: "Equal" }))).toBe("in");
  expect(getZoomActionFromShortcut(chord({ key: "Unidentified", code: "NumpadAdd" }))).toBe("in");
});

test("minus, underscore and the keypad zoom out", () => {
  expect(getZoomActionFromShortcut(chord({ key: "-", code: "Minus" }))).toBe("out");
  expect(getZoomActionFromShortcut(chord({ key: "_", code: "Minus", shift: true }))).toBe("out");
  expect(getZoomActionFromShortcut(chord({ key: "Unidentified", code: "Minus" }))).toBe("out");
  expect(getZoomActionFromShortcut(chord({ key: "Unidentified", code: "NumpadSubtract" }))).toBe(
    "out",
  );
});

test("zero resets, but not Shift+0", () => {
  expect(getZoomActionFromShortcut(chord({ key: "0", code: "Digit0" }))).toBe("reset");
  expect(getZoomActionFromShortcut(chord({ key: "Unidentified", code: "Numpad0" }))).toBe("reset");
  expect(getZoomActionFromShortcut(chord({ key: ")", code: "Digit0", shift: true }))).toBe(
    undefined,
  );
});

test("Alt, the other platform modifier and plain keys stay out of zoom", () => {
  expect(getZoomActionFromShortcut(chord({ alt: true, key: "=", code: "Equal" }))).toBe(undefined);
  expect(getZoomActionFromShortcut(chord({ modifier: false, key: "=", code: "Equal" }))).toBe(
    undefined,
  );
  expect(getZoomActionFromShortcut(chord({ modifier: false, key: "0", code: "Digit0" }))).toBe(
    undefined,
  );
});
