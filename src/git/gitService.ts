// Thin wrapper over the `git` CLI. All diffing is delegated to git so the
// output matches real PR semantics (rename detection, binary detection, etc.).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiffMode, Rev } from '../types';

interface GitOptions {
  /** Non-zero exit codes to treat as success (git diff --no-index returns 1). */
  okCodes?: number[];
}

// Run git in a repo.
function git(repoRoot: string, args: string[], { okCodes = [0] }: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      // core.quotePath=false keeps non-ASCII paths literal instead of octal-escaped.
      ['-c', 'core.quotePath=false', '-C', repoRoot, ...args],
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = (err as (Error & { code?: number }) | null)?.code;
        if (err && (typeof code !== 'number' || !okCodes.includes(code))) {
          reject(new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

export async function resolveRepoRoot(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ['rev-parse', '--show-toplevel']);
    return out.trim() || null;
  } catch {
    return null;
  }
}

// Pick a sensible base ref: prefer main, then master, then origin's default.
export async function getDefaultBase(repoRoot: string): Promise<string> {
  const candidates = ['main', 'master'];
  for (const ref of candidates) {
    try {
      await git(repoRoot, ['rev-parse', '--verify', '--quiet', ref]);
      return ref;
    } catch {
      /* not present */
    }
  }
  try {
    const out = await git(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const ref = out.trim();
    if (ref) return ref; // e.g. "origin/main"
  } catch {
    /* no origin HEAD */
  }
  return 'HEAD'; // last resort: diff against working tree only
}

// Current branch name, or a short SHA when detached.
export async function getHead(repoRoot: string): Promise<string> {
  const name = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (name && name !== 'HEAD') return name;
  const sha = (await git(repoRoot, ['rev-parse', '--short', 'HEAD'])).trim();
  return sha || 'HEAD';
}

async function mergeBase(repoRoot: string, base: string): Promise<string> {
  try {
    return (await git(repoRoot, ['merge-base', base, 'HEAD'])).trim();
  } catch {
    return base; // base may not share history (e.g. HEAD sentinel) — diff directly
  }
}

const DIFF_FLAGS = ['--no-color', '--find-renames', '--find-copies'];

async function untrackedPatches(repoRoot: string): Promise<string> {
  const listing = await git(repoRoot, ['ls-files', '--others', '--exclude-standard']);
  const files = listing
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const patches: string[] = [];
  for (const file of files) {
    // --no-index synthesizes an "added file" patch; exit code 1 == differs.
    const patch = await git(
      repoRoot,
      ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', file],
      { okCodes: [0, 1] }
    );
    if (patch) patches.push(patch);
  }
  return patches.join('');
}

export interface GetDiffOptions {
  base?: string | null;
  mode?: DiffMode;
}

export interface GitDiffResult {
  patch: string;
  head: string;
  base: string;
  mode: DiffMode;
}

/**
 * Produce the raw combined patch text for the requested mode.
 *  - branch:  committed changes on this branch vs base (closest to a real PR)
 *  - working: uncommitted changes (staged + unstaged) + untracked
 *  - all:     branch commits + working tree + untracked (default; superset)
 */
export async function getDiff(
  repoRoot: string,
  { base, mode = 'all' }: GetDiffOptions = {}
): Promise<GitDiffResult> {
  const head = await getHead(repoRoot);
  const baseRef = base || (await getDefaultBase(repoRoot));

  let patch = '';
  if (mode === 'working') {
    patch = await git(repoRoot, ['diff', ...DIFF_FLAGS, 'HEAD']);
    patch += await untrackedPatches(repoRoot);
  } else if (mode === 'branch') {
    const mb = await mergeBase(repoRoot, baseRef);
    patch = await git(repoRoot, ['diff', ...DIFF_FLAGS, mb, 'HEAD']);
  } else {
    // all
    const mb = await mergeBase(repoRoot, baseRef);
    patch = await git(repoRoot, ['diff', ...DIFF_FLAGS, mb]);
    patch += await untrackedPatches(repoRoot);
  }

  return { patch, head, base: baseRef, mode };
}

export interface BlobLinesRequest {
  rev: Rev;
  path: string;
  start: number;
  end: number;
}

export interface BlobLines {
  lines: string[];
  from: number;
  eof: boolean;
}

// Fetch a contiguous range of lines from a file for hunk-context expansion.
// rev === 'WORKTREE' reads the on-disk file (matches what's shown for
// all/working modes, including uncommitted edits); otherwise `git show rev:path`.
// start/end are 1-based inclusive. `eof` is true when `end` reached past the
// last line, so the caller can stop offering further downward expansion.
export async function getBlobLines(
  repoRoot: string,
  { rev, path: filePath, start, end }: BlobLinesRequest
): Promise<BlobLines> {
  let content: string;
  if (rev === 'WORKTREE') {
    const abs = path.join(repoRoot, filePath);
    // guard against path traversal escaping the repo
    if (!abs.startsWith(path.resolve(repoRoot) + path.sep)) {
      return { lines: [], from: Math.max(1, start), eof: true };
    }
    content = await fs.readFile(abs, 'utf8').catch(() => '');
  } else {
    content = await git(repoRoot, ['show', `${rev}:${filePath}`]).catch(() => '');
  }
  const all = content.split('\n');
  if (all.length && all[all.length - 1] === '') all.pop(); // drop trailing newline artifact
  const from = Math.max(1, start);
  const lines = all.slice(from - 1, end);
  return { lines, from, eof: end >= all.length };
}
