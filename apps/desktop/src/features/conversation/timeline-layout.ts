import type { DisplayTimelineItem } from "../../../contracts/timeline-types";

export interface ReadingAnchor {
  readonly rowId: string;
  readonly offsetWithinRow: number;
}
export type TimelinePosition =
  { readonly kind: "following" } | { readonly kind: "reading"; readonly anchor: ReadingAnchor };
export interface TimelineRow {
  readonly item: DisplayTimelineItem;
  readonly top: number;
  readonly height: number;
}
export const TIMELINE_GAP = 16;
export const TIMELINE_OVERSCAN = 720;

export function estimateRowHeight(item: DisplayTimelineItem, width: number): number {
  if (item.kind === "turn-marker") return 32;
  if (item.kind === "turn-changes") return 74 + Math.min(item.turn.files.length, 6) * 36;
  if (item.kind === "message") {
    const charactersPerLine = Math.max(20, Math.floor((width || 700) / 8));
    const lines = item.text
      .split("\n")
      .reduce((count, line) => count + Math.max(1, Math.ceil(line.length / charactersPerLine)), 0);
    return 48 + lines * 24 + (item.attachments?.length ? 160 : 0);
  }
  if (item.kind === "tool") return 52;
  if (item.kind === "summary") return item.presentation === "divider" ? 44 : 38;
  return 38;
}

export interface RowEstimate {
  readonly item: DisplayTimelineItem;
  readonly width: number;
  readonly height: number;
}
export function sameRowContent(a: DisplayTimelineItem, b: DisplayTimelineItem): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "message" && b.kind === "message")
    return a.text === b.text && a.attachments === b.attachments;
  if (a.kind === "tool" && b.kind === "tool")
    return (
      a.status === b.status &&
      a.detail === b.detail &&
      a.label === b.label &&
      a.metadata === b.metadata
    );
  if (a.kind === "summary" && b.kind === "summary")
    return a.label === b.label && a.presentation === b.presentation;
  if (a.kind === "activity" && b.kind === "activity")
    return a.label === b.label && a.detail === b.detail;
  return true;
}
export function layoutRows(
  items: readonly DisplayTimelineItem[],
  heights: ReadonlyMap<string, number>,
  width: number,
  estimates: Map<string, RowEstimate> = new Map(),
): readonly TimelineRow[] {
  let top = 0;
  return items.map((item) => {
    const cached = estimates.get(item.id);
    const estimate =
      cached && cached.width === width && sameRowContent(cached.item, item)
        ? cached.height
        : estimateRowHeight(item, width);
    estimates.set(item.id, { item, width, height: estimate });
    const height = heights.get(item.id) ?? estimate;
    const row = { item, top, height };
    top += height + TIMELINE_GAP;
    return row;
  });
}
export function totalRowHeight(rows: readonly TimelineRow[]): number {
  const last = rows.at(-1);
  return last ? last.top + last.height : 0;
}
export function anchorAt(rows: readonly TimelineRow[], top: number): ReadingAnchor | null {
  const row = rows.find((candidate) => candidate.top + candidate.height > top) ?? rows.at(-1);
  return row ? { rowId: row.item.id, offsetWithinRow: top - row.top } : null;
}
export function resolveAnchor(rows: readonly TimelineRow[], anchor: ReadingAnchor): number | null {
  const row = rows.find((candidate) => candidate.item.id === anchor.rowId);
  return row ? Math.max(0, row.top + Math.min(anchor.offsetWithinRow, row.height)) : null;
}
export function recoverAnchor(
  rows: readonly TimelineRow[],
  previous: readonly TimelineRow[],
  anchor: ReadingAnchor,
): ReadingAnchor | null {
  if (rows.some((row) => row.item.id === anchor.rowId)) return anchor;
  const ids = new Set(rows.map((row) => row.item.id));
  const index = previous.findIndex((row) => row.item.id === anchor.rowId);
  const neighbor =
    previous
      .slice(0, index)
      .reverse()
      .find((row) => ids.has(row.item.id)) ??
    previous.slice(index + 1).find((row) => ids.has(row.item.id)) ??
    rows[0];
  return neighbor ? { rowId: neighbor.item.id, offsetWithinRow: 0 } : null;
}
export function visibleRows(
  rows: readonly TimelineRow[],
  top: number,
  height: number,
): readonly TimelineRow[] {
  return rows.filter(
    (row) =>
      row.top + row.height >= top - TIMELINE_OVERSCAN &&
      row.top <= top + height + TIMELINE_OVERSCAN,
  );
}

/** Preserve native motion that arrived before its scroll event reached React. */
export function compensateAnchorShift(
  actualTop: number,
  previousAnchorTop: number,
  nextAnchorTop: number,
  maximum: number,
): number {
  const clamp = (top: number) => Math.max(0, Math.min(maximum, top));
  const pendingNativeDelta = actualTop - clamp(previousAnchorTop);
  return clamp(nextAnchorTop + pendingNativeDelta);
}
