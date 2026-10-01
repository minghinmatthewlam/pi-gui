import { expect, test } from "@playwright/test";
import type { SessionTranscriptPin } from "@pi-gui/session-driver";
import { visiblePinnedCards } from "../../src/features/extensions/pinned-cards-model";

const pin = (key: string, removed = false): SessionTranscriptPin => ({
  kind: "pin",
  id: `pin:${key}`,
  createdAt: "2026-10-01T12:00:00.000Z",
  card: removed ? null : { key, title: key, tone: "neutral", rows: [], actions: [] },
});

test("the three most recently pinned cards show, after removed and hidden ones drop out", () => {
  const pins = [pin("a"), pin("b"), pin("c", true), pin("d"), pin("e")];
  const ids = (hidden: readonly string[]) =>
    visiblePinnedCards(pins, (candidate) => hidden.includes(candidate.id)).map(({ id }) => id);

  expect(ids([])).toEqual(["pin:b", "pin:d", "pin:e"]);
  // A hidden pin frees its place for an older one.
  expect(ids(["pin:d"])).toEqual(["pin:a", "pin:b", "pin:e"]);
  expect(ids(["pin:a", "pin:b", "pin:d", "pin:e"])).toEqual([]);
});
