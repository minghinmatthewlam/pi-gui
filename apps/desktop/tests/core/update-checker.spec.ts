import { expect, test } from "@playwright/test";
import { compareSemver, releaseUrlFor } from "../../electron/platform/update-checker";

/**
 * Unit coverage for the version comparison that gates update notifications.
 * The old `latest !== current` check misfired on prereleases and newer-local
 * builds; these cases pin the corrected precedence. Runs in Node — no app.
 */

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

test("compareSemver orders released versions", () => {
  expect(sign(compareSemver("0.80.4", "0.80.3"))).toBe(1);
  expect(sign(compareSemver("0.80.3", "0.80.4"))).toBe(-1);
  expect(sign(compareSemver("0.80.3", "0.80.3"))).toBe(0);
  expect(sign(compareSemver("1.0.0", "0.99.99"))).toBe(1);
  expect(sign(compareSemver("0.9.0", "0.10.0"))).toBe(-1);
});

test("compareSemver treats a release as newer than its prereleases", () => {
  expect(sign(compareSemver("0.81.0", "0.81.0-beta.1"))).toBe(1);
  expect(sign(compareSemver("0.81.0-beta.1", "0.81.0"))).toBe(-1);
  expect(sign(compareSemver("0.81.0-beta.2", "0.81.0-beta.1"))).toBe(1);
  expect(sign(compareSemver("0.81.0-beta.1", "0.81.0-beta.10"))).toBe(-1);
});

test("compareSemver does not flag a newer-local build as an update", () => {
  // current = 0.80.4 (local), latest published = 0.80.3 → not an update.
  expect(compareSemver("0.80.3", "0.80.4")).toBeLessThan(0);
});

test("compareSemver returns equal for unparseable input so no update is claimed", () => {
  expect(compareSemver("weird", "0.80.3")).toBe(0);
  expect(compareSemver("0.80.3", "also-weird")).toBe(0);
});

test("releaseUrlFor keeps the selected repository release URL", () => {
  expect(
    releaseUrlFor({
      tag_name: "v0.1.0-beta.34",
      html_url: "https://github.com/minghinmatthewlam/pi-gui/releases/tag/v0.1.0-beta.34",
    }),
  ).toBe("https://github.com/minghinmatthewlam/pi-gui/releases/tag/v0.1.0-beta.34");
});

test("releaseUrlFor falls back to the exact tag instead of the generic latest route", () => {
  expect(releaseUrlFor({ tag_name: "v0.1.0-beta.34" })).toBe(
    "https://github.com/minghinmatthewlam/pi-gui/releases/tag/v0.1.0-beta.34",
  );
  expect(
    releaseUrlFor({
      tag_name: "v0.1.0-beta.34",
      html_url: "https://example.com/releases/tag/v0.1.0-beta.34",
    }),
  ).toBe("https://github.com/minghinmatthewlam/pi-gui/releases/tag/v0.1.0-beta.34");
});
