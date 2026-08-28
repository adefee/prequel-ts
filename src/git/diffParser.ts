// Parses raw `git diff` patch text into the diff model consumed by the
// renderer (same shape as src/sampleDiff.ts). Tolerant of the header variants
// git emits: added/deleted/renamed/copied/binary/mode-only changes.

import crypto from 'node:crypto';
import type { Diff, DiffFile, Hunk } from '../types';

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript',
  cjs: 'javascript', json: 'json', json5: 'json5', md: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'scss', less: 'less', html: 'html', xml: 'xml', yml: 'yaml',
  yaml: 'yaml', toml: 'toml', ini: 'ini', sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  swift: 'swift', sql: 'sql', graphql: 'graphql', gql: 'graphql', vue: 'vue',
  svelte: 'svelte', dockerfile: 'docker', proto: 'proto', tf: 'terraform',
};

export function inferLanguage(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const base = (filePath.split('/').pop() ?? '').toLowerCase();
  if (base === 'dockerfile') return 'docker';
  const ext = base.includes('.') ? (base.split('.').pop() ?? '') : '';
  return EXT_LANG[ext] ?? null;
}

function fileId(oldPath: string, newPath: string): string {
  return crypto.createHash('sha1').update(`${oldPath}\0${newPath}`).digest('hex').slice(0, 12);
}

function stripPrefix(p: string): string | null {
  if (p === '/dev/null') return null;
  // git uses a/ and b/ prefixes; also handle c/ w/ i/ from some diff variants
  return p.replace(/^[abciw]\//, '');
}

type HunkHeader = Omit<Hunk, 'lines'>;

function parseHunkHeader(line: string): HunkHeader | null {
  // @@ -oldStart,oldLen +newStart,newLen @@ optional section heading
  const m = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+(.*)$/.exec(line);
  if (!m) return null;
  return {
    oldStart: parseInt(m[1]!, 10),
    oldLines: m[2] == null ? 1 : parseInt(m[2], 10),
    newStart: parseInt(m[3]!, 10),
    newLines: m[4] == null ? 1 : parseInt(m[4], 10),
    sectionHeading: (m[5] ?? '').replace(/^\s/, ''),
    header: line,
  };
}

export function parseDiff(patch: string): Diff {
  const lines = patch.split('\n');
  const files: DiffFile[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i]!.startsWith('diff --git')) {
      i++;
      continue;
    }

    const file: DiffFile = {
      id: '',
      oldPath: null,
      newPath: null,
      status: 'modified',
      isBinary: false,
      language: null,
      additions: 0,
      deletions: 0,
      mode: null,
      hunks: [],
    };

    // Fallback paths from the "diff --git a/x b/y" line.
    const dg = /^diff --git a\/(.*) b\/(.*)$/.exec(lines[i]!);
    if (dg) {
      file.oldPath = dg[1]!;
      file.newPath = dg[2]!;
    }
    i++;

    // --- header block (until first hunk or next file) ---------------------
    while (i < lines.length && !lines[i]!.startsWith('@@') && !lines[i]!.startsWith('diff --git')) {
      const l = lines[i]!;
      if (l.startsWith('new file mode')) file.status = 'added';
      else if (l.startsWith('deleted file mode')) file.status = 'removed';
      else if (l.startsWith('rename from ')) {
        file.status = 'renamed';
        file.oldPath = l.slice('rename from '.length);
      } else if (l.startsWith('rename to ')) {
        file.status = 'renamed';
        file.newPath = l.slice('rename to '.length);
      } else if (l.startsWith('copy from ')) {
        file.status = 'copied';
        file.oldPath = l.slice('copy from '.length);
      } else if (l.startsWith('copy to ')) {
        file.status = 'copied';
        file.newPath = l.slice('copy to '.length);
      } else if (l.startsWith('old mode') || l.startsWith('new mode')) {
        file.mode = (file.mode ? file.mode + '; ' : '') + l;
      } else if (l.startsWith('Binary files') || l.startsWith('GIT binary patch')) {
        file.isBinary = true;
      } else if (l.startsWith('--- ')) {
        file.oldPath = stripPrefix(l.slice(4).trim());
      } else if (l.startsWith('+++ ')) {
        file.newPath = stripPrefix(l.slice(4).trim());
      }
      i++;
    }

    // --- hunks ------------------------------------------------------------
    let currentHunk: Hunk | null = null;
    let oldNo = 0;
    let newNo = 0;
    while (i < lines.length && !lines[i]!.startsWith('diff --git')) {
      const l = lines[i]!;
      if (l.startsWith('@@')) {
        const h = parseHunkHeader(l);
        if (h) {
          currentHunk = { ...h, lines: [] };
          file.hunks.push(currentHunk);
          oldNo = h.oldStart;
          newNo = h.newStart;
        }
        i++;
        continue;
      }
      if (!currentHunk) {
        i++;
        continue;
      }
      if (l.startsWith('\\')) {
        // "\ No newline at end of file" — annotate the previous line, don't emit.
        i++;
        continue;
      }
      const marker = l[0];
      const content = l.slice(1);
      if (marker === '+') {
        currentHunk.lines.push({ type: 'add', oldNumber: null, newNumber: newNo, content });
        newNo++;
        file.additions++;
      } else if (marker === '-') {
        currentHunk.lines.push({ type: 'del', oldNumber: oldNo, newNumber: null, content });
        oldNo++;
        file.deletions++;
      } else if (marker === ' ') {
        currentHunk.lines.push({ type: 'context', oldNumber: oldNo, newNumber: newNo, content });
        oldNo++;
        newNo++;
      }
      // Anything else (including the blank line between file sections) is
      // skipped defensively.
      i++;
    }

    file.oldPath = file.oldPath || file.newPath;
    file.newPath = file.newPath || file.oldPath;
    file.language = inferLanguage(file.status === 'removed' ? file.oldPath : file.newPath);
    file.id = fileId(file.oldPath ?? '', file.newPath ?? '');
    files.push(file);
  }

  return { files };
}
