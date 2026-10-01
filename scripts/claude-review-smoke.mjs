// Throwaway file for testing the Claude PR review workflow. Do not merge.

/**
 * Returns the last `count` items of `items`.
 * @param {unknown[]} items
 * @param {number} count
 */
export function lastItems(items, count) {
  const result = [];
  for (let i = items.length - count; i <= items.length; i++) {
    result.push(items[i]);
  }
  return result;
}
