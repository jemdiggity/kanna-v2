/**
 * Fuzzy file-path matcher inspired by VSCode's fuzzyScorer.
 *
 * Matches query characters in order (not necessarily contiguous) against a
 * file path, producing a numeric score and the indices of matched characters.
 *
 * Scoring bonuses (per character):
 *   +1  base match
 *   +1  exact case
 *   +8  start of string
 *   +5  after path separator (/)
 *   +4  after word separator (_ - . space)
 *   +2  camelCase boundary
 *   +5  first 3 consecutive matches (each), +3 thereafter
 */

export interface FuzzyResult {
  score: number;
  indices: number[];
}

const WORD_SEPARATORS = new Set(["_", "-", ".", " "]);

function isUpperCase(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

function charScore(
  target: string,
  targetIdx: number,
  queryChar: string,
  consecutive: number,
): { score: number; consecutive: number } {
  let s = 1; // base match

  // exact case bonus
  if (target[targetIdx] === queryChar) {
    s += 1;
  }

  // positional bonuses
  if (targetIdx === 0) {
    s += 8; // start of string
  } else {
    const prev = target[targetIdx - 1];
    if (prev === "/") {
      s += 5; // after path separator
    } else if (WORD_SEPARATORS.has(prev)) {
      s += 4; // after word separator
    } else if (isUpperCase(target[targetIdx]) && !isUpperCase(prev)) {
      s += 2; // camelCase boundary
    }
  }

  // consecutive bonus with plateau
  const nextConsecutive = consecutive + 1;
  if (nextConsecutive > 1) {
    s += nextConsecutive <= 3 ? 5 : 3;
  }

  return { score: s, consecutive: nextConsecutive };
}

/**
 * Score a single query against a target string using a greedy forward scan
 * with a preference for word-boundary matches.
 *
 * Returns null if the query doesn't match.
 */
function scoreSegment(
  query: string,
  target: string,
): FuzzyResult | null {
  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();

  if (queryLower.length > targetLower.length) return null;

  // Quick rejection: every query char must exist somewhere
  for (let i = 0; i < queryLower.length; i++) {
    if (targetLower.indexOf(queryLower[i], 0) === -1) return null;
  }

  // Two-pass approach:
  // 1) Prefer word-boundary aligned matches (greedy)
  // 2) Fall back to first-available match
  // Take the higher score.
  const boundaryResult = scorePath(query, queryLower, target, targetLower, true);
  const greedyResult = scorePath(query, queryLower, target, targetLower, false);

  if (!boundaryResult && !greedyResult) return null;
  if (!boundaryResult) return greedyResult;
  if (!greedyResult) return boundaryResult;
  return boundaryResult.score >= greedyResult.score ? boundaryResult : greedyResult;
}

function isBoundary(target: string, idx: number): boolean {
  if (idx === 0) return true;
  const prev = target[idx - 1];
  if (prev === "/" || WORD_SEPARATORS.has(prev)) return true;
  if (isUpperCase(target[idx]) && !isUpperCase(prev)) return true;
  return false;
}

function scorePath(
  query: string,
  queryLower: string,
  target: string,
  targetLower: string,
  preferBoundary: boolean,
): FuzzyResult | null {
  const indices: number[] = [];
  let totalScore = 0;
  let consecutive = 0;
  let targetIdx = 0;

  for (let qi = 0; qi < queryLower.length; qi++) {
    const qch = queryLower[qi];
    let matched = false;

    if (preferBoundary) {
      // Look for a boundary match first (scan ahead)
      let boundaryIdx = -1;
      for (let ti = targetIdx; ti < targetLower.length; ti++) {
        if (targetLower[ti] === qch && isBoundary(target, ti)) {
          boundaryIdx = ti;
          break;
        }
      }
      if (boundaryIdx !== -1) {
        // Check gap penalty: if we skip characters, reset consecutive
        if (boundaryIdx > targetIdx) consecutive = 0;
        const cs = charScore(target, boundaryIdx, query[qi], consecutive);
        totalScore += cs.score;
        consecutive = cs.consecutive;
        indices.push(boundaryIdx);
        targetIdx = boundaryIdx + 1;
        matched = true;
      }
    }

    if (!matched) {
      // First-available match
      for (let ti = targetIdx; ti < targetLower.length; ti++) {
        if (targetLower[ti] === qch) {
          if (ti > targetIdx) consecutive = 0;
          const cs = charScore(target, ti, query[qi], consecutive);
          totalScore += cs.score;
          consecutive = cs.consecutive;
          indices.push(ti);
          targetIdx = ti + 1;
          matched = true;
          break;
        }
      }
    }

    if (!matched) return null;
  }

  return { score: totalScore, indices };
}

/**
 * Fuzzy-match a query against a file path.
 *
 * Supports multi-part queries: "comp btn" matches both "comp" and "btn"
 * against the path independently, requiring all parts to match.
 *
 * Applies a filename bonus: if the query (or any part) matches entirely within
 * the filename portion, the score is boosted.
 */
export function fuzzyMatch(query: string, filePath: string): FuzzyResult | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);

  // Single query — score against filename first, then full path
  if (parts.length === 1) {
    return scoreSingle(parts[0], filePath);
  }

  // Multi-part: all parts must match, aggregate scores
  let totalScore = 0;
  const allIndices: number[] = [];

  for (const part of parts) {
    const result = scoreSingle(part, filePath);
    if (!result) return null;
    totalScore += result.score;
    allIndices.push(...result.indices);
  }

  return { score: totalScore, indices: [...new Set(allIndices)].sort((a, b) => a - b) };
}

function scoreSingle(query: string, filePath: string): FuzzyResult | null {
  const lastSlash = filePath.lastIndexOf("/");
  const filename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;

  // Try filename first — boost if matched
  const filenameResult = scoreSegment(query, filename);
  if (filenameResult) {
    const offset = lastSlash >= 0 ? lastSlash + 1 : 0;
    return {
      // Filename matches get a large bonus to sort above directory matches
      score: filenameResult.score + 1000,
      indices: filenameResult.indices.map((i) => i + offset),
    };
  }

  // Fall back to full path
  return scoreSegment(query, filePath);
}
