/**
 * Subsequence fuzzy matching for the command palette.
 *
 * Every query character must appear in order. Matches at word starts and runs
 * of consecutive characters score higher; skipped characters cost a little.
 * Whitespace in the query is ignored, so "app tsx" finds "App.tsx".
 */

export interface FuzzyMatch {
  readonly score: number;
  /** Indices into the candidate text, ascending. */
  readonly positions: readonly number[];
}

// Weights follow fzf: a run inside one word beats letters scattered across words.
const SCORE_MATCH = 16;
const BONUS_PATH_START = 9;
const BONUS_WORD_START = 8;
const BONUS_CAMEL = 7;
const BONUS_CONSECUTIVE = 8;
const BONUS_FIRST_CHAR = 3;
/** A gap of n characters costs PENALTY_GAP_START + (n - 1). */
const PENALTY_GAP_START = 3;
const PENALTY_LEADING_GAP = 0.05;
const NONE = Number.NEGATIVE_INFINITY;

function isSeparator(char: string): boolean {
  return (
    char === "/" ||
    char === "\\" ||
    char === "-" ||
    char === "_" ||
    char === "." ||
    char === " " ||
    char === ":"
  );
}

function boundaryBonus(text: string, index: number): number {
  if (index === 0) {
    return BONUS_FIRST_CHAR + BONUS_WORD_START;
  }
  const previous = text[index - 1] ?? "";
  if (previous === "/" || previous === "\\") {
    return BONUS_PATH_START;
  }
  if (isSeparator(previous)) {
    return BONUS_WORD_START;
  }
  const current = text[index] ?? "";
  if (previous !== previous.toUpperCase() && current !== current.toLowerCase()) {
    return BONUS_CAMEL;
  }
  return 0;
}

export function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, "").toLowerCase();
}

/**
 * Returns the best-scoring alignment of `query` inside `text`, or null when
 * `query` is not a subsequence. `query` must already be normalized.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const queryLength = query.length;
  if (queryLength === 0) {
    return { score: 0, positions: [] };
  }
  const textLength = text.length;
  if (queryLength > textLength) {
    return null;
  }
  const lower = text.toLowerCase();

  // Cheap rejection before the quadratic pass.
  let cursor = 0;
  for (let index = 0; index < queryLength; index += 1) {
    cursor = lower.indexOf(query[index] as string, cursor);
    if (cursor < 0) {
      return null;
    }
    cursor += 1;
  }

  // scores[i][j]: best score with query[i] matched at text[j].
  // from[i][j]: text index of query[i - 1] in that alignment.
  const scores: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let row = 0; row < queryLength; row += 1) {
    const rowScores = new Float64Array(textLength).fill(NONE);
    const rowFrom = new Int32Array(textLength).fill(-1);
    const char = query[row] as string;
    const previousScores = row > 0 ? scores[row - 1] : undefined;
    // Best of previous[k] + k over k < column - 1, with its k.
    let bestGapValue = NONE;
    let bestGapIndex = -1;
    for (let column = row; column < textLength; column += 1) {
      if (previousScores && column >= 2) {
        const candidate = previousScores[column - 2] as number;
        if (candidate !== NONE) {
          const value = candidate + (column - 2);
          if (value > bestGapValue) {
            bestGapValue = value;
            bestGapIndex = column - 2;
          }
        }
      }
      if (lower[column] !== char) {
        continue;
      }
      const bonus = boundaryBonus(text, column);
      if (!previousScores) {
        rowScores[column] = SCORE_MATCH + bonus - PENALTY_LEADING_GAP * column;
        continue;
      }
      let best = NONE;
      let bestFrom = -1;
      const adjacent = previousScores[column - 1] as number;
      if (adjacent !== NONE) {
        best = adjacent + SCORE_MATCH + bonus + BONUS_CONSECUTIVE;
        bestFrom = column - 1;
      }
      if (bestGapValue !== NONE) {
        // previous[k] - (PENALTY_GAP_START + column - k - 2)
        const gapped = bestGapValue - column - PENALTY_GAP_START + 2 + SCORE_MATCH + bonus;
        if (gapped > best) {
          best = gapped;
          bestFrom = bestGapIndex;
        }
      }
      rowScores[column] = best;
      rowFrom[column] = bestFrom;
    }
    scores.push(rowScores);
    from.push(rowFrom);
  }

  const lastScores = scores[queryLength - 1] as Float64Array;
  let bestScore = NONE;
  let bestEnd = -1;
  for (let column = queryLength - 1; column < textLength; column += 1) {
    const value = lastScores[column] as number;
    if (value > bestScore) {
      bestScore = value;
      bestEnd = column;
    }
  }
  if (bestEnd < 0) {
    return null;
  }

  const positions = new Array<number>(queryLength);
  let column = bestEnd;
  for (let row = queryLength - 1; row >= 0; row -= 1) {
    positions[row] = column;
    column = (from[row] as Int32Array)[column] as number;
  }
  return { score: bestScore, positions };
}

export interface RankedMatch<T> {
  readonly item: T;
  readonly match: FuzzyMatch;
}

/** Ranks items by their best-matching text, highest score first. Stable on ties. */
export function rankByFuzzy<T>(
  items: readonly T[],
  query: string,
  textOf: (item: T) => string,
  limit = Number.POSITIVE_INFINITY,
): readonly RankedMatch<T>[] {
  const normalized = normalizeQuery(query);
  const ranked: RankedMatch<T>[] = [];
  for (const item of items) {
    const match = fuzzyMatch(normalized, textOf(item));
    if (match) {
      ranked.push({ item, match });
    }
  }
  ranked.sort((left, right) => right.match.score - left.match.score);
  return ranked.slice(0, limit);
}

/**
 * Ranks workspace-relative paths, preferring a match inside the file name over
 * one spread across directories. Positions index into the full path.
 */
export function rankPaths(
  paths: readonly string[],
  query: string,
  limit: number,
): readonly RankedMatch<string>[] {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    return paths.slice(0, limit).map((item) => ({ item, match: { score: 0, positions: [] } }));
  }
  const ranked: RankedMatch<string>[] = [];
  for (const path of paths) {
    const full = fuzzyMatch(normalized, path);
    if (!full) {
      continue;
    }
    const nameStart = path.lastIndexOf("/") + 1;
    const name = nameStart > 0 ? fuzzyMatch(normalized, path.slice(nameStart)) : null;
    const match =
      name && name.score + BONUS_WORD_START >= full.score
        ? {
            score: name.score + BONUS_WORD_START,
            positions: name.positions.map((position) => position + nameStart),
          }
        : full;
    // Shorter paths win ties, so "README.md" beats "docs/old/README.md".
    ranked.push({ item: path, match: { ...match, score: match.score - path.length * 0.01 } });
  }
  ranked.sort((left, right) => right.match.score - left.match.score);
  return ranked.slice(0, limit);
}
