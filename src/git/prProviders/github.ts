// GitHub PR review comments via the `gh` CLI (github.com or GHE via GH_HOST).
import { execFile } from "node:child_process";
import { HttpError } from "../../errors";
import { isSafeGhHost } from "../prConfig";
import { isGithubDotCom } from "../pushRemote";
import type { PushRemote } from "../pushRemote";
import type {
  PrCommentThread,
  PrCommentsProvider,
  ProviderContext,
  ProviderHints,
  PushLocalCommentInput,
} from "./types";

export interface RawReviewComment {
  id: number;
  path: string;
  line: number | null;
  original_line: number | null;
  side: "LEFT" | "RIGHT";
  body: string;
  user: { login: string } | null;
  html_url: string;
  created_at: string;
  in_reply_to_id?: number;
}

function gh(repoRoot: string, args: string[], ghHost?: string | null): Promise<string> {
  if (ghHost && !isSafeGhHost(ghHost)) {
    return Promise.reject(new Error("invalid GitHub host"));
  }
  const env = ghHost ? { ...process.env, GH_HOST: ghHost } : process.env;
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(stdout);
          return;
        }
        const code = (err as Error & { code?: unknown }).code;
        if (code === "ENOENT") {
          reject(new Error("gh CLI not found — install it from https://cli.github.com"));
          return;
        }
        reject(new Error(stderr.trim() || err.message));
      },
    );
  });
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

function isNameWithOwner(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

async function fetchResolvedCommentIds(
  repoRoot: string,
  nameWithOwner: string,
  number: number,
  ghHost?: string | null,
): Promise<Set<number>> {
  const [owner, name] = nameWithOwner.split("/");
  if (!owner || !name) {
    return new Set();
  }
  try {
    const raw = await gh(
      repoRoot,
      [
        "api",
        "graphql",
        "-f",
        `query=${RESOLVED_THREADS_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${number}`,
      ],
      ghHost,
    );
    const nodes = (JSON.parse(raw) as ResolvedThreadsResponse).data?.repository?.pullRequest
      ?.reviewThreads?.nodes;
    const ids = new Set<number>();
    for (const thread of nodes ?? []) {
      if (!thread.isResolved) {
        continue;
      }
      for (const comment of thread.comments.nodes) {
        ids.add(comment.databaseId);
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}

export function threadsFromReviewComments(
  comments: RawReviewComment[],
  resolvedIds: Set<number>,
): PrCommentThread[] {
  const byThread = new Map<number, RawReviewComment[]>();
  for (const comment of comments) {
    const key = comment.in_reply_to_id ?? comment.id;
    if (!byThread.has(key)) {
      byThread.set(key, []);
    }
    byThread.get(key)!.push(comment);
  }

  const threads: PrCommentThread[] = [];
  for (const group of byThread.values()) {
    if (group.some((comment) => resolvedIds.has(comment.id))) {
      continue;
    }
    group.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const rootLike = group.find((comment) => !comment.in_reply_to_id) ?? group[0]!;
    const line = rootLike.line ?? rootLike.original_line;
    if (!rootLike.path || !line) {
      continue;
    }
    threads.push({
      path: rootLike.path,
      side: rootLike.side === "LEFT" ? "old" : "new",
      line,
      comments: group.map((comment) => ({
        author: comment.user?.login ?? "unknown",
        body: comment.body,
        createdAt: comment.created_at,
        url: comment.html_url,
      })),
    });
  }
  return threads;
}

async function fetchGithubPrReviewComments(
  repoRoot: string,
  branch: string,
  ghHost?: string | null,
): Promise<PrCommentThread[]> {
  const numOut = await gh(repoRoot, ["pr", "view", branch, "--json", "number"], ghHost);
  const { number } = JSON.parse(numOut) as { number: number };
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("no open PR for this branch");
  }
  const repoOut = await gh(repoRoot, ["repo", "view", "--json", "nameWithOwner"], ghHost);
  const { nameWithOwner } = JSON.parse(repoOut) as { nameWithOwner: string };
  if (!nameWithOwner || !isNameWithOwner(nameWithOwner)) {
    throw new Error("could not resolve GitHub repo");
  }
  const [raw, resolvedIds] = await Promise.all([
    gh(repoRoot, ["api", `repos/${nameWithOwner}/pulls/${number}/comments?per_page=100`], ghHost),
    fetchResolvedCommentIds(repoRoot, nameWithOwner, number, ghHost),
  ]);
  return threadsFromReviewComments(JSON.parse(raw) as RawReviewComment[], resolvedIds);
}

function matchesGithub(remote: PushRemote | null, hints: ProviderHints): boolean {
  if (hints.ghHost) {
    return true;
  }
  return Boolean(remote && isGithubDotCom(remote.host));
}

export const githubProvider: PrCommentsProvider = {
  id: "github",
  label: "GitHub",
  canPush: false,
  auth: {
    need: "ghHost",
    toastLabel: "Set GH host…",
    prompt: "GitHub Enterprise hostname (e.g. github.example.com):",
  },
  matches: matchesGithub,
  async fetchComments(ctx: ProviderContext) {
    return fetchGithubPrReviewComments(ctx.repoRoot, ctx.branch, ctx.ghHost);
  },
  async pushComment(_ctx: ProviderContext, _input: PushLocalCommentInput) {
    throw new HttpError(400, "Posting review comments is not supported for GitHub yet");
  },
};
