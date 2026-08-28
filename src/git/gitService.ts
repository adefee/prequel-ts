// Thin wrapper over the `git` CLI. All diffing is delegated to git so the
// output matches real PR semantics (rename detection, binary detection, etc.).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_DIFF_MODE, type BranchInfo, type DiffMode, type Rev } from '../types';

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

async function headHasCommit(repoRoot: string): Promise<boolean> {
  try {
    await git(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

// Current branch name, or a short SHA when detached. Unborn HEAD (no commits)
// is represented as the branch name when there is one, otherwise 'HEAD'.
export async function getHead(repoRoot: string): Promise<string> {
  try {
    const name = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (name && name !== 'HEAD') return name;
  } catch {
    /* unborn or missing HEAD */
  }
  try {
    const sha = (await git(repoRoot, ['rev-parse', '--short', 'HEAD'])).trim();
    if (sha) return sha;
  } catch {
    /* no commit yet */
  }
  return 'HEAD';
}

async function mergeBase(repoRoot: string, base: string, head: string): Promise<string> {
  try {
    return (await git(repoRoot, ['merge-base', base, head])).trim();
  } catch {
    return base; // base may not share history (e.g. HEAD sentinel) — diff directly
  }
}

/** Reject names that would be unsafe as git rev arguments or HTML/URL values. */
export function isSafeRefName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name === 'HEAD' || name === 'WORKTREE') return true;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return false;
  if (name.includes('\0') || name.includes('..') || name.includes('\\') || name.includes('@{')) {
    return false;
  }
  if (/[\x00-\x1f ~^:?*[\]]/.test(name)) return false;
  return true;
}

/** Accept a user-supplied compare ref only if it names a real commit. */
export async function resolveCompareRef(
  repoRoot: string,
  requested: string | null | undefined
): Promise<string | null> {
  const name = requested?.trim() ?? '';
  if (!name || !isSafeRefName(name)) return null;
  try {
    await git(repoRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${name}^{commit}`]);
    return name;
  } catch {
    return null;
  }
}

async function gitCommonDir(repoRoot: string): Promise<string> {
  const raw = (await git(repoRoot, ['rev-parse', '--git-common-dir'])).trim();
  return path.resolve(repoRoot, raw);
}

function isoFromUnixSeconds(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

function unixFromReflogLine(line: string): number | null {
  const meta = line.split('\t')[0] ?? '';
  const parts = meta.split(' ');
  const unix = Number(parts[parts.length - 2]);
  return Number.isFinite(unix) && unix > 0 ? unix : null;
}

async function remoteRefFetchedAt(commonDir: string, upstream: string): Promise<string | null> {
  const rel = upstream.split('/');
  const logPath = path.join(commonDir, 'logs', 'refs', 'remotes', ...rel);
  try {
    const text = await fs.readFile(logPath, 'utf8');
    const lines = text.replace(/\n+$/, '').split('\n');
    const last = lines[lines.length - 1] || '';
    const unix = unixFromReflogLine(last);
    if (unix != null) return isoFromUnixSeconds(unix);
  } catch {
    /* no reflog — packed or never fetched as a remote-tracking ref */
  }
  const refPath = path.join(commonDir, 'refs', 'remotes', ...rel);
  try {
    const st = await fs.stat(refPath);
    return st.mtime.toISOString();
  } catch {
    return null;
  }
}

export function fetchedLabel(iso: string | null): string {
  if (!iso) return 'no remote';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'no remote';
  const sec = Math.floor((Date.now() - then) / 1000);
  if (sec < 45) return 'fetched just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `fetched ${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `fetched ${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `fetched ${days}d ago`;
  return `fetched ${new Date(then).toLocaleDateString()}`;
}

export function fetchedTitle(info: Pick<BranchInfo, 'upstream' | 'fetchedAt'>): string {
  if (!info.fetchedAt) {
    return info.upstream
      ? `Tracks ${info.upstream}, but no fetch time is available`
      : 'This branch has no remote tracking branch';
  }
  const when = new Date(info.fetchedAt).toLocaleString();
  return info.upstream ? `Last fetched from ${info.upstream} at ${when}` : `Last fetched at ${when}`;
}

export async function listLocalBranches(repoRoot: string): Promise<BranchInfo[]> {
  const out = await git(repoRoot, [
    'for-each-ref',
    '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)',
    'refs/heads',
  ]);
  const rows = out
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => {
      const [name, headMark, upstream] = line.split('\0');
      return { name: name ?? '', current: headMark === '*', upstream: upstream || null };
    })
    .filter((row) => row.name);

  const commonDir = await gitCommonDir(repoRoot);
  const uniqueUpstreams = [...new Set(rows.map((r) => r.upstream).filter((u): u is string => Boolean(u)))];
  const fetched = new Map<string, string | null>();
  await Promise.all(
    uniqueUpstreams.map(async (up) => {
      fetched.set(up, await remoteRefFetchedAt(commonDir, up));
    })
  );

  return rows.map((row) => ({
    name: row.name,
    current: row.current,
    upstream: row.upstream,
    fetchedAt: row.upstream ? (fetched.get(row.upstream) ?? null) : null,
  }));
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
  /** Compare this ref as the PR head; defaults to the checked-out branch. */
  head?: string | null;
  mode?: DiffMode;
}

export interface CompareMeta {
  head: string;
  base: string;
  checkedOut: string;
}

export async function getCompareMeta(
  repoRoot: string,
  { base, head }: Pick<GetDiffOptions, 'base' | 'head'> = {}
): Promise<CompareMeta> {
  const checkedOut = await getHead(repoRoot);
  const headRef = (await resolveCompareRef(repoRoot, head)) || checkedOut;
  const baseRef = (await resolveCompareRef(repoRoot, base)) || (await getDefaultBase(repoRoot));
  return { head: headRef, base: baseRef, checkedOut };
}

export interface GitDiffResult extends CompareMeta {
  patch: string;
  mode: DiffMode;
}

/**
 * Produce the raw combined patch text for the requested mode.
 *  - branch:  committed changes on this branch vs base (closest to a real PR)
 *  - working: uncommitted changes (staged + unstaged) + untracked
 *  - all:     branch commits + working tree + untracked (default; superset)
 *
 * `head` may name a local branch other than the checkout. Working-tree
 * overlay (`all` / `working`) only applies when that ref is the checkout.
 */
export async function getDiff(
  repoRoot: string,
  { base, head, mode = DEFAULT_DIFF_MODE }: GetDiffOptions = {}
): Promise<GitDiffResult> {
  const { head: headRef, base: baseRef, checkedOut } = await getCompareMeta(repoRoot, {
    base,
    head,
  });
  const headIsCheckout = headRef === checkedOut || headRef === 'HEAD';

  let patch = '';
  if (mode === 'working') {
    if (await headHasCommit(repoRoot)) {
      patch = await git(repoRoot, ['diff', ...DIFF_FLAGS, headRef]);
    }
    patch += await untrackedPatches(repoRoot);
  } else if (mode === 'branch' || !headIsCheckout) {
    const mb = await mergeBase(repoRoot, baseRef, headRef);
    patch = await git(repoRoot, ['diff', ...DIFF_FLAGS, mb, headRef]);
  } else {
    // all, and the selected head is the checkout — include the worktree
    const mb = await mergeBase(repoRoot, baseRef, 'HEAD');
    patch = await git(repoRoot, ['diff', ...DIFF_FLAGS, mb]);
    patch += await untrackedPatches(repoRoot);
  }

  return { patch, head: headRef, base: baseRef, mode, checkedOut };
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
