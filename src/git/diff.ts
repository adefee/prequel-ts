import crypto from 'node:crypto';
import { parsePatch, type StructuredPatch, type StructuredPatchHunk } from 'diff';

export type LineType = 'context' | 'add' | 'del';
export type FileStatus = 'added' | 'modified' | 'removed' | 'renamed' | 'copied';

export interface ReviewLine {
  type: LineType;
  oldNumber: number | null;
  newNumber: number | null;
  content: string;
}

export interface ReviewHunk {
  header: string;
  sectionHeading: string;
  oldStart: number;
  newStart: number;
  oldLines?: number;
  newLines?: number;
  lines: ReviewLine[];
}

export interface ReviewFile {
  id: string;
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  isBinary: boolean;
  language: string | null;
  additions: number;
  deletions: number;
  mode: string | null;
  hunks: ReviewHunk[];
}

export interface ReviewDiff {
  files: ReviewFile[];
  base?: string;
  head?: string;
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  json5: 'json5',
  md: 'markdown',
  markdown: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  xml: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  vue: 'vue',
  svelte: 'svelte',
  dockerfile: 'docker',
  proto: 'proto',
  tf: 'terraform',
};

export function inferLanguage(filePath: string | null | undefined): string | null {
  if (!filePath) {
    return null;
  }

  const base = (filePath.split('/').pop() ?? '').toLowerCase();
  if (base === 'dockerfile') {
    return 'docker';
  }

  const ext = base.includes('.') ? (base.split('.').pop() ?? '') : '';
  return EXT_LANG[ext] ?? null;
}

function fileId(oldPath: string | null, newPath: string | null): string {
  return crypto
    .createHash('sha1')
    .update(`${oldPath ?? ''}\0${newPath ?? ''}`)
    .digest('hex')
    .slice(0, 12);
}

function gitPath(fileName: string | undefined, prefix: 'a/' | 'b/'): string | null {
  if (!fileName || fileName === '/dev/null') {
    return null;
  }

  return fileName.startsWith(prefix) ? fileName.slice(prefix.length) : fileName;
}

function paths(file: StructuredPatch): [string | null, string | null] {
  return [
    file.isCreate ? null : gitPath(file.oldFileName, 'a/'),
    file.isDelete ? null : gitPath(file.newFileName, 'b/'),
  ];
}

function status(file: StructuredPatch): FileStatus {
  if (file.isCopy) {
    return 'copied';
  }
  if (file.isRename) {
    return 'renamed';
  }
  if (file.isCreate) {
    return 'added';
  }
  if (file.isDelete) {
    return 'removed';
  }

  return 'modified';
}

function mapHunk(hunk: StructuredPatchHunk): ReviewHunk {
  let oldNumber = hunk.oldStart;
  let newNumber = hunk.newStart;
  const lines = hunk.lines.flatMap<ReviewLine>((line) => {
    const operation = line[0];
    const content = line.slice(1);
    if (operation === '+') {
      return [{ type: 'add', oldNumber: null, newNumber: newNumber++, content }];
    }

    if (operation === '-') {
      return [{ type: 'del', oldNumber: oldNumber++, newNumber: null, content }];
    }

    if (operation === ' ') {
      return [{ type: 'context', oldNumber: oldNumber++, newNumber: newNumber++, content }];
    }

    // Git's missing-final-newline marker has no review coordinate.
    return [];
  });

  return {
    header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    sectionHeading: '',
    oldStart: hunk.oldStart,
    newStart: hunk.newStart,
    oldLines: hunk.oldLines,
    newLines: hunk.newLines,
    lines,
  };
}

function mapFile(file: StructuredPatch): ReviewFile {
  const [oldPath, newPath] = paths(file);
  const hunks = file.hunks.map(mapHunk);
  const reviewStatus = status(file);
  const mode = [file.oldMode && `old mode ${file.oldMode}`, file.newMode && `new mode ${file.newMode}`]
    .filter(Boolean)
    .join('; ') || null;

  return {
    id: fileId(oldPath, newPath),
    oldPath,
    newPath,
    status: reviewStatus,
    isBinary: file.isBinary ?? false,
    language: inferLanguage(reviewStatus === 'removed' ? oldPath : newPath),
    additions: hunks.flatMap((hunk) => hunk.lines).filter((line) => line.type === 'add').length,
    deletions: hunks.flatMap((hunk) => hunk.lines).filter((line) => line.type === 'del').length,
    mode,
    hunks,
  };
}

export function parseDiff(patch: string): ReviewDiff {
  return {
    files: parsePatch(patch).map(mapFile),
  };
}
