/**
 * Offsets count the characters of `root.textContent`, so an annotation can be anchored again
 * after its row unmounts (virtualization) or the markdown re-renders.
 */
export function rangeToOffsets(
  root: Node,
  range: Range,
): { readonly start: number; readonly end: number } {
  const before = document.createRange();
  before.setStart(root, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return { start, end: start + range.toString().length };
}

export function offsetsToRange(root: Node, start: number, end: number): Range | null {
  if (end <= start) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let seen = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue?.length ?? 0;
    if (!started && start < seen + length) {
      range.setStart(node, start - seen);
      started = true;
    }
    if (started && end <= seen + length) {
      range.setEnd(node, end - seen);
      return range;
    }
    seen += length;
  }
  return null;
}
