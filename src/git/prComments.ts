// Read-only fetch of a GitHub PR's line-anchored review comments, via the
// `gh` CLI. Never writes anything back to GitHub — the UI uses these purely
// as read-only context for a local prequel comment (see client/comments.ts).
import { execFile } from 'node:child_process';
import { isSafeRefName } from './gitService';
import type { CommentSide } from '../types';

function gh(repoRoot: string, args: string[], ghHost?: string | null): Promise<string> {
  const env = ghHost ? { ...process.env, GH_HOST: ghHost } : process.env;
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (!err) {
        resolve(stdout);
        return;
      }
      const code = (err as Error & { code?: unknown }).code;
      if (code === 'ENOENT') {
        reject(new Error('gh CLI not found — install it from https://cli.github.com'));
        return;
      }
      reject(new Error(stderr.trim() || err.message));
    });
  });
}

interface RawReviewComment {
  id: number;
  path: string;
  line: number | null;
  original_line: number | null;
  side: 'LEFT' | 'RIGHT';
  body: string;
  user: { login: string } | null;
  html_url: string;
  created_at: string;
  in_reply_to_id?: number;
}

export interface PrComment {
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface PrCommentThread {
  path: string;
  side: CommentSide;
  line: number;
  comments: PrComment[];
}

const RESOLVED_THREADS_QUERY = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes { isResolved comments(first: 50) { nodes { databaseId } } }
        }
      }
    }
  }
`;

interface ResolvedThreadsResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: { isResolved: boolean; comments: { nodes: { databaseId: number }[] } }[];
        };
      };
    };
  };
}

// REST has no "resolved" field on a review comment; only the GraphQL thread
// does. Best-effort: a failure here (older `gh`, missing scope) just means
// resolved threads get imported too, not that the whole fetch fails.
async function fetchResolvedCommentIds(
  repoRoot: string,
  nameWithOwner: string,
  number: number,
  ghHost?: string | null
): Promise<Set<number>> {
  const [owner, name] = nameWithOwner.split('/');
  try {
    const raw = await gh(
      repoRoot,
      [
        'api',
        'graphql',
        '-f',
        `query=${RESOLVED_THREADS_QUERY}`,
        '-F',
        `owner=${owner}`,
        '-F',
        `name=${name}`,
        '-F',
        `number=${number}`,
      ],
      ghHost
    );
    const nodes = (JSON.parse(raw) as ResolvedThreadsResponse).data?.repository?.pullRequest
      ?.reviewThreads?.nodes;
    const ids = new Set<number>();
    for (const t of nodes ?? []) {
      if (!t.isResolved) continue;
      for (const c of t.comments.nodes) ids.add(c.databaseId);
    }
    return ids;
  } catch {
    return new Set();
  }
}

// One GitHub review comment thread per gutter line — enough to anchor it next
// to the matching local diff line; the ceiling is 100 review comments (one
// page), which every PR this tool is meant for comfortably fits under.
export async function fetchPrReviewComments(
  repoRoot: string,
  branch: string,
  ghHost?: string | null
): Promise<PrCommentThread[]> {
  if (!isSafeRefName(branch)) throw new Error('unsafe branch name');
  const numOut = await gh(repoRoot, ['pr', 'view', branch, '--json', 'number'], ghHost);
  const { number } = JSON.parse(numOut) as { number: number };
  const repoOut = await gh(repoRoot, ['repo', 'view', '--json', 'nameWithOwner'], ghHost);
  const { nameWithOwner } = JSON.parse(repoOut) as { nameWithOwner: string };
  const [raw, resolvedIds] = await Promise.all([
    gh(repoRoot, ['api', `repos/${nameWithOwner}/pulls/${number}/comments?per_page=100`], ghHost),
    fetchResolvedCommentIds(repoRoot, nameWithOwner, number, ghHost),
  ]);
  const comments = JSON.parse(raw) as RawReviewComment[];

  const byThread = new Map<number, RawReviewComment[]>();
  for (const c of comments) {
    const key = c.in_reply_to_id ?? c.id;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key)!.push(c);
  }

  const threads: PrCommentThread[] = [];
  for (const group of byThread.values()) {
    if (group.some((c) => resolvedIds.has(c.id))) continue; // resolved on GitHub already
    group.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const rootLike = group.find((c) => !c.in_reply_to_id) ?? group[0]!;
    const line = rootLike.line ?? rootLike.original_line;
    if (!rootLike.path || !line) continue; // outdated position — nothing to anchor to
    threads.push({
      path: rootLike.path,
      side: rootLike.side === 'LEFT' ? 'old' : 'new',
      line,
      comments: group.map((c) => ({
        author: c.user?.login ?? 'unknown',
        body: c.body,
        createdAt: c.created_at,
        url: c.html_url,
      })),
    });
  }
  return threads;
}
