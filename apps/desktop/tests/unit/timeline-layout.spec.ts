import { test, expect } from "@playwright/test";
import type { DisplayTimelineItem } from "../../contracts/timeline-types";
import {
  layoutRows,
  compensateAnchorShift,
  anchorAt,
  resolveAnchor,
  recoverAnchor,
  visibleRows,
  totalRowHeight,
  type RowEstimate,
} from "../../src/features/conversation/timeline-layout";
const message = (id: string, text = "test"): DisplayTimelineItem => ({
  kind: "message",
  id,
  role: "assistant",
  text,
  createdAt: "2026-09-19T00:00:00Z",
});

test("a measurement above the reading row moves its offset but preserves its anchor", () => {
  const items = [message("a"), message("b"), message("c")];
  const before = layoutRows(
    items,
    new Map([
      ["a", 100],
      ["b", 100],
      ["c", 100],
    ]),
    700,
  );
  const anchor = anchorAt(before, 140)!;
  const after = layoutRows(
    items,
    new Map([
      ["a", 900],
      ["b", 100],
      ["c", 100],
    ]),
    700,
  );
  expect(anchor).toEqual({ rowId: "b", offsetWithinRow: 24 });
  expect(resolveAnchor(after, anchor)).toBe(940);
});
test("cold tall tails stay mounted while resolving the bottom without mounting history", () => {
  const items = Array.from({ length: 500 }, (_, i) =>
    message(String(i), i === 499 ? "long response ".repeat(4000) : "hello"),
  );
  const rows = layoutRows(items, new Map(), 700);
  const visible = visibleRows(rows, totalRowHeight(rows) - 800, 800);
  expect(visible.at(-1)?.item.id).toBe("499");
  expect(visible.length).toBeLessThan(20);
});
test("removed anchors fall back to surviving display rows, including turn markers", () => {
  const marker: DisplayTimelineItem = {
    kind: "turn-marker",
    id: "turn-marker:a",
    durationMs: 5000,
  };
  const before = layoutRows([message("a"), marker, message("b")], new Map(), 700);
  const after = layoutRows([message("a"), message("b")], new Map(), 700);
  expect(recoverAnchor(after, before, { rowId: marker.id, offsetWithinRow: 10 })).toEqual({
    rowId: "a",
    offsetWithinRow: 0,
  });
});
test("estimates update with content and width while preserving measurements", () => {
  const estimates = new Map<string, RowEstimate>();
  const short = layoutRows([message("a")], new Map(), 700, estimates);
  const long = layoutRows([message("a", "word ".repeat(2000))], new Map(), 700, estimates);
  const narrow = layoutRows([message("a", "word ".repeat(2000))], new Map(), 300, estimates);
  expect(long[0]!.height).toBeGreaterThan(short[0]!.height);
  expect(narrow[0]!.height).toBeGreaterThan(long[0]!.height);
  expect(layoutRows([message("a")], new Map([["a", 123]]), 700, estimates)[0]!.height).toBe(123);
});

test("anchor correction preserves pending native motion and does not apply browser clamping twice", () => {
  expect(compensateAnchorShift(460, 500, 580, 1000)).toBe(540);
  expect(compensateAnchorShift(500, 900, 400, 500)).toBe(400);
  expect(compensateAnchorShift(460, 500, 500, 1000)).toBe(460);
});
test("an extension card re-estimates when its rows change and keeps its estimate otherwise", () => {
  const card = (rows: number): DisplayTimelineItem => ({
    kind: "card",
    id: "card-entry",
    createdAt: "2026-09-30T00:00:00Z",
    card: {
      title: "CI failed on main",
      tone: "error",
      rows: Array.from({ length: rows }, (_, i) => ({ label: `Row ${i}`, value: "value" })),
      actions: [],
    },
  });
  const estimates = new Map<string, RowEstimate>();
  const oneRow = layoutRows([card(1)], new Map(), 700, estimates)[0]!.height;
  expect(layoutRows([card(1)], new Map(), 700, estimates)[0]!.height).toBe(oneRow);
  const threeRows = layoutRows([card(3)], new Map(), 700, estimates)[0]!.height;
  expect(threeRows).toBeGreaterThan(oneRow);
  expect(estimates.get("card-entry")?.height).toBe(threeRows);
});
