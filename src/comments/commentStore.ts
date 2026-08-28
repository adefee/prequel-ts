// Central, per-repo comment persistence: ~/.prequel/<repo-hash>.json.
// Keeps the reviewed repo pristine (nothing to gitignore). Each comment is
// tagged with the branch it was written on. Writes are atomic (temp + rename).

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Comment, CommentInput, CommentPatch } from '../types';

const DIR = path.join(os.homedir(), '.prequel');

function fileFor(repoRoot: string): string {
  const hash = crypto.createHash('sha1').update(repoRoot).digest('hex').slice(0, 16);
  return path.join(DIR, `${hash}.json`);
}

async function readAll(repoRoot: string): Promise<Comment[]> {
  try {
    const raw = await fs.readFile(fileFor(repoRoot), 'utf8');
    const data = JSON.parse(raw) as { comments?: unknown };
    return Array.isArray(data.comments) ? (data.comments as Comment[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(repoRoot: string, comments: Comment[]): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  const dest = fileFor(repoRoot);
  const tmp = `${dest}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ repoRoot, comments }, null, 2));
  await fs.rename(tmp, dest);
}

// Serialize read-modify-write per repo so concurrent mutations can't clobber
// each other. The stored tail always fulfills so a failed write doesn't stall
// later ones or become an unhandled rejection.
const repoLocks = new Map<string, Promise<unknown>>();

function withRepoLock<T>(repoRoot: string, op: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repoRoot) ?? Promise.resolve();
  const next = prev.then(op);
  const tail = next.then(
    () => undefined,
    () => undefined
  );
  repoLocks.set(repoRoot, tail);
  void tail.finally(() => {
    if (repoLocks.get(repoRoot) === tail) repoLocks.delete(repoRoot);
  });
  return next;
}

export async function listComments(repoRoot: string, branch?: string | null): Promise<Comment[]> {
  const all = await readAll(repoRoot);
  return branch ? all.filter((c) => c.branch === branch) : all;
}

export async function addComment(repoRoot: string, data: CommentInput): Promise<Comment> {
  return withRepoLock(repoRoot, async () => {
    const all = await readAll(repoRoot);
    const now = new Date().toISOString();
    const comment: Comment = {
      id: crypto.randomUUID(),
      repoRoot,
      createdAt: now,
      updatedAt: now,
      status: 'open',
      ...data,
    };
    all.push(comment);
    await writeAll(repoRoot, all);
    return comment;
  });
}

export async function getComment(repoRoot: string, id: string): Promise<Comment | null> {
  const all = await readAll(repoRoot);
  return all.find((c) => c.id === id) ?? null;
}

export async function updateComment(
  repoRoot: string,
  id: string,
  patch: CommentPatch
): Promise<Comment | null> {
  return withRepoLock(repoRoot, async () => {
    const all = await readAll(repoRoot);
    const comment = all.find((c) => c.id === id);
    if (!comment) return null;
    Object.assign(comment, patch, { updatedAt: new Date().toISOString() });
    await writeAll(repoRoot, all);
    return comment;
  });
}

// Deleting a root comment also deletes its replies — a reply without its
// comment has nothing to attach to and would be invisible in the UI.
export async function deleteComment(repoRoot: string, id: string): Promise<number | false> {
  return withRepoLock(repoRoot, async () => {
    const all = await readAll(repoRoot);
    if (!all.some((c) => c.id === id)) return false;
    const kept = all.filter((c) => c.id !== id && c.parentId !== id);
    await writeAll(repoRoot, kept);
    return all.length - kept.length;
  });
}

// In-memory buffer of the last bulk-clear, so the UI can offer a quick Undo.
const lastCleared = new Map<string, Comment[]>();

export async function clearComments(repoRoot: string, branch?: string | null): Promise<number> {
  return withRepoLock(repoRoot, async () => {
    const all = await readAll(repoRoot);
    const cleared = branch ? all.filter((c) => c.branch === branch) : all.slice();
    const kept = branch ? all.filter((c) => c.branch !== branch) : [];
    lastCleared.set(repoRoot, cleared);
    await writeAll(repoRoot, kept);
    return cleared.length;
  });
}

export async function restoreCleared(repoRoot: string): Promise<number> {
  return withRepoLock(repoRoot, async () => {
    const cleared = lastCleared.get(repoRoot);
    if (!cleared || !cleared.length) return 0;
    const all = await readAll(repoRoot);
    all.push(...cleared);
    lastCleared.delete(repoRoot);
    await writeAll(repoRoot, all);
    return cleared.length;
  });
}
