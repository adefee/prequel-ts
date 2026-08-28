// Builds the payload handed to Claude Code from review comments. Default is
// grouped-by-file, code-fenced markdown (embeds the repo root + each comment's
// code snapshot so Claude can locate the spot even if line numbers shifted).

import { inferLanguage } from '../git/diffParser';
import type { Comment } from '../types';

function lineLabel(c: Comment): string {
  return c.startLine === c.endLine ? `Line ${c.startLine}` : `Lines ${c.startLine}–${c.endLine}`;
}

// Comment ids ride along as HTML comments: invisible in rendered markdown,
// but readable by anything reading the raw text — which is how a client marks
// the right comment resolved once it has addressed it.
function idMarker(c: Comment): string {
  return `<!-- prequel:id ${c.id} -->`;
}

function blockquote(body: string | null | undefined): string {
  return String(body || '')
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

function bySortedFile(comments: Comment[]): Array<[string, Comment[]]> {
  const groups = new Map<string, Comment[]>();
  for (const c of comments) {
    if (!groups.has(c.filePath)) groups.set(c.filePath, []);
    groups.get(c.filePath)!.push(c);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([file, list]) => [file, list.sort((a, b) => a.startLine - b.startLine)]);
}

export function buildMarkdown(
  repoRoot: string,
  branch: string | null,
  comments: Comment[]
): string {
  const out: string[] = [];
  out.push(`# Review feedback${branch ? ` — ${branch}` : ''}`);
  out.push(`Repo: ${repoRoot}`);
  out.push('');
  out.push('Please address each review comment below; make the requested change for each.');
  out.push('');

  for (const [file, list] of bySortedFile(comments)) {
    out.push(`## ${file}`);
    out.push('');
    const lang = inferLanguage(file) || '';
    for (const c of list) {
      if (c.side === 'file') {
        out.push('### File comment');
        out.push(idMarker(c));
        out.push(blockquote(c.body));
        out.push('');
        continue;
      }
      out.push(`### ${lineLabel(c)}${c.side === 'old' ? ' (old side)' : ''}`);
      out.push(idMarker(c));
      const code = (c.lineSnapshot || []).join('\n');
      if (code) {
        out.push('```' + lang);
        out.push(code);
        out.push('```');
      }
      out.push(blockquote(c.body));
      out.push('');
    }
  }
  return out.join('\n').replace(/\n+$/, '') + '\n';
}

export function buildJson(comments: Comment[]): string {
  return JSON.stringify(
    bySortedFile(comments).flatMap(([file, list]) =>
      list.map((c) => ({
        id: c.id,
        file,
        side: c.side,
        lines: c.side === 'file' ? null : [c.startLine, c.endLine],
        code: (c.lineSnapshot || []).join('\n'),
        comment: c.body,
      }))
    ),
    null,
    2
  );
}
