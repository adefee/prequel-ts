// Computes intra-line (word-level) diffs for paired deletion/addition lines,
// like GitHub's darker within-line red/green. Produces character ranges on each
// line (`line.wordRanges`) that the highlighter wraps in a word-highlight span.

import type { CharRange, Diff, DiffLine } from '../types';

// Split into word tokens, whitespace runs, and individual punctuation chars.
function tokenize(s: string): string[] {
  return s.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
}

// Longest common subsequence of token arrays → matched index pairs.
function lcsMatches(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const matched: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      matched.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return matched;
}

// Merge the char spans of unmatched (changed) tokens into ranges.
function unmatchedRanges(tokens: string[], matchedIdx: Set<number>): CharRange[] {
  const ranges: CharRange[] = [];
  let offset = 0;
  let curStart = -1;
  let curEnd = -1;
  tokens.forEach((tok, idx) => {
    const start = offset;
    const end = offset + tok.length;
    if (!matchedIdx.has(idx)) {
      if (curStart < 0) {
        curStart = start;
        curEnd = end;
      } else if (start === curEnd) {
        curEnd = end; // contiguous — extend
      } else {
        ranges.push([curStart, curEnd]);
        curStart = start;
        curEnd = end;
      }
    }
    offset = end;
  });
  if (curStart >= 0) ranges.push([curStart, curEnd]);
  return ranges;
}

export interface WordDiff {
  oldRanges: CharRange[];
  newRanges: CharRange[];
}

// Cap the LCS table (O(n·m) Int32s). Over-limit pairs take the same empty-range
// path as the 20% similarity fallback below, so the line stays a full replace.
const MAX_LCS_TOKENS = 256;

export function computeWordDiff(oldStr: string, newStr: string): WordDiff {
  const a = tokenize(oldStr);
  const b = tokenize(newStr);
  const matches =
    a.length > MAX_LCS_TOKENS || b.length > MAX_LCS_TOKENS ? [] : lcsMatches(a, b);

  // If the lines share little, a full-line replacement reads better without
  // noisy word highlights — skip (GitHub does similar).
  const commonChars = matches.reduce((sum, [i]) => sum + a[i]!.length, 0);
  const maxLen = Math.max(oldStr.length, newStr.length, 1);
  if (commonChars / maxLen < 0.2) return { oldRanges: [], newRanges: [] };

  return {
    oldRanges: unmatchedRanges(a, new Set(matches.map((mm) => mm[0]))),
    newRanges: unmatchedRanges(b, new Set(matches.map((mm) => mm[1]))),
  };
}

// Attach `line.wordRanges` to paired deletion/addition lines within each hunk.
export function annotateWordDiffs(diff: Diff): Diff {
  for (const file of diff.files) {
    if (file.isBinary) continue;
    for (const hunk of file.hunks) {
      const lines = hunk.lines;
      let i = 0;
      while (i < lines.length) {
        const type = lines[i]!.type;
        if (type !== 'del' && type !== 'add') {
          i++;
          continue;
        }
        // Gather a maximal change block, splitting into dels then adds.
        const dels: DiffLine[] = [];
        const adds: DiffLine[] = [];
        let j = i;
        while (j < lines.length && (lines[j]!.type === 'del' || lines[j]!.type === 'add')) {
          (lines[j]!.type === 'del' ? dels : adds).push(lines[j]!);
          j++;
        }
        const pairs = Math.min(dels.length, adds.length);
        for (let k = 0; k < pairs; k++) {
          const { oldRanges, newRanges } = computeWordDiff(dels[k]!.content, adds[k]!.content);
          dels[k]!.wordRanges = oldRanges;
          adds[k]!.wordRanges = newRanges;
        }
        i = j;
      }
    }
  }
  return diff;
}
