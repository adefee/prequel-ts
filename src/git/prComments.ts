// Read-only fetch of a PR's line-anchored review comments.
// GitHub (github.com or an explicit GHE host) goes through `gh`; 
// we assume other remotes use an API like Forgejo/Gitea HTTP API. 
import { execFile } from "node:child_process";
import type { CommentSide } from "../comments/commentStore";
import { HttpError } from "../errors";
import { fetchForgejoPrReviewComments, postForgejoReviewComment } from "./forgejoComments";
import { isSafeGhHost } from "./prConfig";
import { isGithubDotCom, resolvePushRemote, type PushRemote } from "./pushRemote";
import { isSafeRefName } from "./repository";

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

export type PrCommentProvider = "github" | "forgejo";

export interface FetchPrCommentsResult {
  threads: PrCommentThread[];
  provider: PrCommentProvider;
  remote: PushRemote | null;
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

// REST has no "resolved" field on a review comment; only the GraphQL thread
// does. Best-effort: a failure here (older `gh`, missing scope) just means
// resolved threads get imported too, not that the whole fetch fails.
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

// One GitHub review comment thread per gutter line — enough to anchor it next
// to the matching local diff line; the ceiling is 100 review comments (one
// page), which every PR this tool is meant for comfortably fits under.
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
      continue; // resolved on GitHub already
    }
    group.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const rootLike = group.find((comment) => !comment.in_reply_to_id) ?? group[0]!;
    const line = rootLike.line ?? rootLike.original_line;
    if (!rootLike.path || !line) {
      continue; // outdated position — nothing to anchor to
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

/** Prefer GitHub when the push remote is github.com, or an explicit GHE host is set. */
export function choosePrCommentProvider(
  remote: PushRemote | null,
  ghHost?: string | null,
): PrCommentProvider {
  if (ghHost) {
    return "github";
  }
  if (remote && isGithubDotCom(remote.host)) {
    return "github";
  }
  return "forgejo";
}

export async function fetchPrReviewComments(
  repoRoot: string,
  branch: string,
  options: {
    ghHost?: string | null;
    forgeToken?: string | null;
  } = {},
): Promise<FetchPrCommentsResult> {
  if (!isSafeRefName(branch)) {
    throw new Error("unsafe branch name");
  }
  const remote = await resolvePushRemote(repoRoot, branch);
  const provider = choosePrCommentProvider(remote, options.ghHost);

  if (provider === "github") {
    const threads = await fetchGithubPrReviewComments(repoRoot, branch, options.ghHost);
    return { threads, provider, remote };
  }

  if (!remote) {
    throw new HttpError(400, "could not resolve git push remote");
  }
  if (!options.forgeToken) {
    throw new HttpError(401, "Forgejo token required", { needs: "forgeToken" });
  }
  const threads = await fetchForgejoPrReviewComments(remote, branch, options.forgeToken);
  return { threads, provider, remote };
}

export interface PushLocalCommentInput {
  path: string;
  side: "old" | "new";
  line: number;
  body: string;
}

export interface PushLocalCommentResult {
  provider: "forgejo";
  pullNumber: number;
  htmlUrl: string;
}

/** Post one local line comment to the open Forgejo/Gitea PR for `branch`. */
export async function pushLocalCommentToPr(
  repoRoot: string,
  branch: string,
  input: PushLocalCommentInput,
  options: {
    ghHost?: string | null;
    forgeToken?: string | null;
  } = {},
): Promise<PushLocalCommentResult> {
  if (!isSafeRefName(branch)) {
    throw new Error("unsafe branch name");
  }
  const remote = await resolvePushRemote(repoRoot, branch);
  const provider = choosePrCommentProvider(remote, options.ghHost);
  if (provider === "github") {
    throw new HttpError(400, "Posting review comments is only supported for Forgejo/Gitea remotes");
  }
  if (!remote) {
    throw new HttpError(400, "could not resolve git push remote");
  }
  if (!options.forgeToken) {
    throw new HttpError(401, "Forgejo token required", { needs: "forgeToken" });
  }
  const posted = await postForgejoReviewComment(remote, branch, options.forgeToken, input);
  return { provider: "forgejo", ...posted };
}
