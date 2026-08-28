import { describe, expect, test } from 'bun:test';
import type { ReviewDiff } from '../git/diff';
import { annotateWordDiffs, computeWordDiff } from './wordDiff';
import { highlightDiff } from './highlighter';
import { renderDiff } from './renderer';

const review: ReviewDiff = { files: [{
  id: 'unsafe', oldPath: 'a<&.unknown', newPath: 'a<&.unknown', status: 'modified',
  isBinary: false, language: 'not-a-language', additions: 2, deletions: 1, mode: null,
  hunks: [{ header: '@@ -3 +3,2 @@ <unsafe>', sectionHeading: '', oldStart: 3, newStart: 3,
    lines: [
      { type: 'del', oldNumber: 3, newNumber: null, content: 'hello old world <b>' },
      { type: 'add', oldNumber: null, newNumber: 3, content: 'hello new world <b>' },
      { type: 'add', oldNumber: null, newNumber: 4, content: '<script>alert(1)</script>' },
    ] }],
}, {
  id: 'binary', oldPath: 'image.png', newPath: 'image.png', status: 'modified',
  isBinary: true, language: null, additions: 0, deletions: 0, mode: null, hunks: [],
}] };

describe('render projection', () => {
  test('keeps review data stable and renders ranges, anchors, alignment, counts and escaping', async () => {
    const projected = annotateWordDiffs(review);
    expect(review.files[0]!.hunks[0]!.lines[0]).toEqual({ type: 'del', oldNumber: 3, newNumber: null, content: 'hello old world <b>' });
    expect(projected.files[0]!.hunks[0]!.lines[2]!.wordRanges).toBeUndefined();
    const rendered = await highlightDiff(projected);
    const { filesHtml, summary } = renderDiff(rendered, { view: 'split' });
    expect(summary).toEqual({ fileCount: 2, additions: 2, deletions: 1 });
    expect(filesHtml).toContain('class="tok wd"');
    expect(filesHtml).toContain('data-side="old" data-comment-line="3"');
    expect(filesHtml).toContain('data-side="new" data-comment-line="3"');
    expect(filesHtml).toContain('a&lt;&amp;.unknown');
    expect(filesHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(filesHtml).toContain('blob-code-empty');
    expect(filesHtml).toContain('Binary file not shown.');
  });

  test('maps jsdiff changes while retaining local whitespace and noise policy', () => {
    expect(computeWordDiff('hello old world', 'hello new world')).toEqual({ oldRanges: [[6, 9]], newRanges: [[6, 9]] });
    const whitespace = computeWordDiff('a  b', 'a b');
    expect(whitespace.oldRanges.length + whitespace.newRanges.length).toBeGreaterThan(0);
    expect(computeWordDiff('completely unrelated', 'nothing alike')).toEqual({ oldRanges: [], newRanges: [] });
  });
});
