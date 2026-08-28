import { diffWordsWithSpace } from 'diff';
import type { CharRange, RenderDiff, RenderLine, ReviewDiff } from '../types';

export interface WordDiff {
  oldRanges: CharRange[];
  newRanges: CharRange[];
}

function appendRange(ranges: CharRange[], start: number, end: number): void {
  const last = ranges[ranges.length - 1];
  if (last && last[1] === start) last[1] = end;
  else ranges.push([start, end]);
}

export function computeWordDiff(oldText: string, newText: string): WordDiff {
  const oldRanges: CharRange[] = [];
  const newRanges: CharRange[] = [];
  let oldOffset = 0;
  let newOffset = 0;
  let commonChars = 0;

  for (const part of diffWordsWithSpace(oldText, newText)) {
    const length = part.value.length;
    if (part.added) {
      appendRange(newRanges, newOffset, newOffset + length);
      newOffset += length;
    } else if (part.removed) {
      appendRange(oldRanges, oldOffset, oldOffset + length);
      oldOffset += length;
    } else {
      commonChars += length;
      oldOffset += length;
      newOffset += length;
    }
  }
  if (commonChars / Math.max(oldText.length, newText.length, 1) < 0.2) {
    return { oldRanges: [], newRanges: [] };
  }
  return { oldRanges, newRanges };
}

export function annotateWordDiffs(diff: ReviewDiff): RenderDiff {
  return {
    ...diff,
    files: diff.files.map((file) => ({
      ...file,
      hunks: file.hunks.map((hunk) => {
        const lines: RenderLine[] = hunk.lines.map((line) => ({ ...line }));
        if (!file.isBinary) {
          let i = 0;
          while (i < lines.length) {
            if (lines[i]!.type !== 'del' && lines[i]!.type !== 'add') { i++; continue; }
            const dels: RenderLine[] = [];
            const adds: RenderLine[] = [];
            let j = i;
            while (j < lines.length && (lines[j]!.type === 'del' || lines[j]!.type === 'add')) {
              (lines[j]!.type === 'del' ? dels : adds).push(lines[j]!);
              j++;
            }
            for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
              const ranges = computeWordDiff(dels[k]!.content, adds[k]!.content);
              dels[k]!.wordRanges = ranges.oldRanges;
              adds[k]!.wordRanges = ranges.newRanges;
            }
            i = j;
          }
        }
        return { ...hunk, lines };
      }),
    })),
  };
}
