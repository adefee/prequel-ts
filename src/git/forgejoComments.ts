// Forgejo/Gitea PR review comments via the HTTP API (import + post).
import type { CommentSide } from "../comments/commentStore";
import { HttpError } from "../errors";
import type { PrComment, PrCommentThread } from "./prComments";
import type { PushRemote } from "./pushRemote";

interface ForgeUser {
  login?: string;
  username?: string;
  name?: string;
}

interface ForgePull {
  number: number;
  html_url?: string;
  head?: { ref?: string; name?: string };
}

interface ForgeReview {
  id: number;
  comments_count?: number;
  dismissed?: boolean;
  state?: string;
  html_url?: string;
}

interface ForgeReviewComment {
  id: number;
  body: string;
  user?: ForgeUser | null;
  html_url?: string;
  created_at: string;
  path: string;
  // Create API / modern responses
  old_position?: number | null;
  new_position?: number | null;
  // Older response field names
  position?: number | null;
  original_position?: number | null;
}

export type { PrCommentThread };

async function forgeRequest<T>(
  baseUrl: string,
  apiPath: string,
  token: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1${apiPath}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json",
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (err) {
    throw new HttpError(502, err instanceof Error ? err.message : "Forgejo request failed");
  }
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(401, "Forgejo authentication failed", { needs: "forgeToken" });
  }
  if (!res.ok) {
    const text = (await res.text()).trim();
    throw new HttpError(
      res.status >= 400 && res.status < 600 ? res.status : 502,
      text || `Forgejo API ${res.status}`,
    );
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

function forgeGet<T>(baseUrl: string, apiPath: string, token: string): Promise<T> {
  return forgeRequest<T>(baseUrl, apiPath, token);
}

function authorOf(user: ForgeUser | null | undefined): string {
  return user?.login || user?.username || user?.name || "unknown";
}

function headRef(pull: ForgePull): string | null {
  return pull.head?.ref || pull.head?.name || null;
}

function anchorOf(comment: ForgeReviewComment): { side: CommentSide; line: number } | null {
  const newPos = comment.new_position ?? comment.position ?? null;
  const oldPos = comment.old_position ?? comment.original_position ?? null;
  if (typeof newPos === "number" && newPos > 0) {
    return { side: "new", line: newPos };
  }
  if (typeof oldPos === "number" && oldPos > 0) {
    return { side: "old", line: oldPos };
  }
  return null;
}

/** Pure: map Forgejo review comments into prequel threads (one per path+side+line). */
export function threadsFromForgejoComments(comments: ForgeReviewComment[]): PrCommentThread[] {
  const byKey = new Map<
    string,
    { path: string; side: CommentSide; line: number; comments: PrComment[] }
  >();
  for (const comment of comments) {
    if (!comment.path || !comment.body) {
      continue;
    }
    const anchor = anchorOf(comment);
    if (!anchor) {
      continue;
    }
    const key = `${comment.path}\0${anchor.side}\0${anchor.line}`;
    let thread = byKey.get(key);
    if (!thread) {
      thread = { path: comment.path, side: anchor.side, line: anchor.line, comments: [] };
      byKey.set(key, thread);
    }
    thread.comments.push({
      author: authorOf(comment.user),
      body: comment.body,
      createdAt: comment.created_at,
      url: comment.html_url || "",
    });
  }
  const threads = [...byKey.values()];
  for (const thread of threads) {
    thread.comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return threads;
}

async function findOpenPull(remote: PushRemote, branch: string, token: string): Promise<ForgePull> {
  const { baseUrl, owner, repo } = remote;
  const pulls = await forgeGet<ForgePull[]>(
    baseUrl,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&limit=50`,
    token,
  );
  const pull = pulls.find((p) => headRef(p) === branch);
  if (!pull) {
    throw new HttpError(404, "no open PR for this branch");
  }
  return pull;
}

export async function fetchForgejoPrReviewComments(
  remote: PushRemote,
  branch: string,
  token: string,
): Promise<PrCommentThread[]> {
  const { baseUrl, owner, repo } = remote;
  const pull = await findOpenPull(remote, branch, token);

  const reviews = await forgeGet<ForgeReview[]>(
    baseUrl,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pull.number}/reviews`,
    token,
  );

  const all: ForgeReviewComment[] = [];
  for (const review of reviews) {
    if (review.dismissed || review.state === "PENDING") {
      continue;
    }
    if (review.comments_count === 0) {
      continue;
    }
    const comments = await forgeGet<ForgeReviewComment[]>(
      baseUrl,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pull.number}/reviews/${review.id}/comments`,
      token,
    );
    all.push(...comments);
  }

  return threadsFromForgejoComments(all);
}

export interface PostForgejoReviewCommentInput {
  path: string;
  side: "old" | "new";
  line: number;
  body: string;
}

export interface PostForgejoReviewCommentResult {
  pullNumber: number;
  htmlUrl: string;
}

/** Create a COMMENT review with one inline note on the open PR for `branch`. */
export async function postForgejoReviewComment(
  remote: PushRemote,
  branch: string,
  token: string,
  input: PostForgejoReviewCommentInput,
): Promise<PostForgejoReviewCommentResult> {
  if (!input.path || !input.body.trim()) {
    throw new HttpError(400, "path and body required");
  }
  if (!Number.isInteger(input.line) || input.line <= 0) {
    throw new HttpError(400, "invalid line");
  }

  const pull = await findOpenPull(remote, branch, token);
  const { baseUrl, owner, repo } = remote;
  const review = await forgeRequest<ForgeReview>(
    baseUrl,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pull.number}/reviews`,
    token,
    {
      method: "POST",
      body: {
        body: "",
        event: "COMMENT",
        comments: [
          {
            path: input.path,
            body: input.body,
            new_position: input.side === "new" ? input.line : 0,
            old_position: input.side === "old" ? input.line : 0,
          },
        ],
      },
    },
  );

  return {
    pullNumber: pull.number,
    htmlUrl: review.html_url || pull.html_url || "",
  };
}
