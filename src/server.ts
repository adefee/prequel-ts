// HTTP layer: Bun.serve on 127.0.0.1. Renders the review page with EJS and
// exposes the JSON API the browser (and Claude, via the skill) talks to.
//
// Every request is scoped to a project path — `?repo=`, then a JSON body's
// `repo`, then `x-prequel-repo`, falling back to the CLI's default. That is
// what lets one process back several browser tabs on different repos.

import ejs from "ejs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderCommentHtml } from "./comments/commentHtml";
import {
  listComments as listCommentsStore,
  addComment as addCommentStore,
  getComment as getCommentStore,
  updateComment as updateCommentStore,
  deleteComment as deleteCommentStore,
  clearComments as clearCommentsStore,
  restoreCleared as restoreClearedStore,
  type Comment,
  type CommentAuthor,
  type CommentSide,
  type CommentStatus,
} from "./comments/commentStore";
import { HttpError, messageOf, statusOf } from "./errors";
import { buildMarkdown, buildJson } from "./export/claudeExport";
import { parseDiff, inferLanguage, type ReviewDiff } from "./git/diff";
import { fetchPrReviewComments, pushLocalCommentToPr } from "./git/prComments";
import {
  getForgeToken,
  getGhHost,
  isSafeForgeToken,
  isSafeGhHost,
  setForgeToken,
  setGhHost,
} from "./git/prConfig";
import {
  DEFAULT_DIFF_MODE,
  fetchedLabel,
  fetchedTitle,
  getCompareMeta,
  getDiff,
  getBlobLines,
  isSafeRefName,
  listLocalBranches,
  resolveCompareRef,
  resolveRepoRoot,
  type BranchInfo,
  type DiffMode,
  type Rev,
} from "./git/repository";
import { highlightDiff, highlightLines } from "./render/highlighter";
import { renderDiff, renderFileTree, type ViewMode } from "./render/renderer";
import { annotateWordDiffs } from "./render/wordDiff";
import { sampleDiff } from "./sampleDiff";

type ColorMode = "light" | "dark" | "auto";

interface CommentWithHtml extends Comment {
  bodyHtml: string;
}

interface RepoScope {
  repoRoot: string | null;
  displayPath: string;
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(projectRoot, "public");
const primerCssDir = path.join(projectRoot, "node_modules", "@primer", "primitives", "dist", "css");
const reviewStartTemplate = path.join(projectRoot, "views", "review-start.ejs");
const reviewEndTemplate = path.join(projectRoot, "views", "review-end.ejs");
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-accel-buffering": "no",
} as const;

const DIFF_MODES: DiffMode[] = ["all", "branch", "working"];
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_VITE_ORIGIN = "http://127.0.0.1:5173";

type JsonBody = Record<string, unknown>;

// Resolve a user-supplied filesystem path to a repo the server can serve.
// Returns the git toplevel when the path is inside a repo; otherwise keeps the
// absolute directory (sample-diff mode). Rejects missing / non-directory paths.
async function resolveRepoSwitch(input: unknown): Promise<RepoScope> {
  if (typeof input !== "string") {
    throw new HttpError(400, "path required");
  }
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes("\0")) {
    throw new HttpError(400, "invalid path");
  }
  const abs = path.resolve(trimmed);
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    throw new HttpError(404, "path not found");
  }
  if (!st.isDirectory()) {
    throw new HttpError(400, "path is not a directory");
  }
  const root = await resolveRepoRoot(abs);
  return { repoRoot: root, displayPath: root || abs };
}

// Rendered markdown for the client (sanitized; interpolated as HTML in the tab).
function withHtml(c: Comment): CommentWithHtml {
  return { ...c, bodyHtml: renderCommentHtml(c.body) };
}

// Best-effort: add ".prequel/" to the repo's local git exclude so exported
// review files don't appear as untracked in the diff or get committed. Uses
// .git/info/exclude so the user's tracked .gitignore is left untouched.
async function ensureExcluded(repoRoot: string): Promise<void> {
  try {
    const p = path.join(repoRoot, ".git", "info", "exclude");
    let cur = "";
    try {
      cur = await fs.readFile(p, "utf8");
    } catch {
      /* file may not exist yet */
    }
    if (cur.split("\n").some((l) => l.trim() === ".prequel/")) {
      return;
    }
    const prefix = cur && !cur.endsWith("\n") ? cur + "\n" : cur;
    await fs.writeFile(p, prefix + ".prequel/\n");
  } catch {
    /* .git may be a file (worktree/submodule) or unwritable — ignore */
  }
}

// --- request/response helpers ---------------------------------------------
const json = (data: unknown, status = 200): Response => Response.json(data, { status });
const text = (body: string, status: number): Response => new Response(body, { status });
const apiError = (err: unknown): Response => {
  const body: Record<string, unknown> = { error: messageOf(err) };
  if (err instanceof HttpError && err.extras) {
    Object.assign(body, err.extras);
  }
  return json(body, statusOf(err));
};

// Browser mutations must be same-origin. curl / the skill send neither
// Sec-Fetch-Site nor Origin and are not a CSRF vector, so they pass.
function assertSameOrigin(req: Request): void {
  const site = req.headers.get("sec-fetch-site");
  if (site === "same-origin") {
    return;
  }
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (origin === new URL(req.url).origin) {
        return;
      }
    } catch {
      /* malformed request URL */
    }
  } else if (!site) {
    return;
  }
  throw new HttpError(403, "cross-origin request");
}

// POST bodies are small JSON documents; anything larger is refused outright.
async function readJsonBody(req: Request): Promise<JsonBody> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, "body too large");
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw new HttpError(413, "body too large");
  }
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonBody)
      : {};
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

// Serve a file from `root`, refusing anything that resolves outside it.
async function serveStatic(root: string, relative: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return text("Bad request", 400);
  }
  if (!decoded || decoded.includes("\0")) {
    return text("Not found", 404);
  }
  const abs = path.resolve(root, decoded);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return text("Forbidden", 403);
  }
  const file = Bun.file(abs);
  if (!(await file.exists())) {
    return text("Not found", 404);
  }
  return new Response(file);
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface ServerOptions {
  /** Git toplevel the CLI was started in, or null when it isn't a repo. */
  repoRoot?: string | null;
  /** Base ref to diff against when a request doesn't pin one. */
  defaultBase?: string | null;
  /**
   * Origin of the Vite dev server. When set, the page loads client modules
   * from it (HMR) instead of the built bundles in public/dist.
   */
  viteOrigin?: string | null;
  /** Override persistent comment storage (tests use a temporary directory). */
  commentDir?: string;
}

function viteOriginFromEnv(): string | null {
  if (process.env.PREQUEL_DEV !== "1") {
    return null;
  }
  return process.env.PREQUEL_VITE_ORIGIN || DEFAULT_VITE_ORIGIN;
}

/**
 * Build the request handler. Returned separately from listening so the CLI can
 * own port selection (and so it can be exercised without a socket).
 */
export function createApp(options: ServerOptions = {}): (req: Request) => Promise<Response> {
  const defaultRepoRoot = options.repoRoot ?? null;
  const defaultBase = options.defaultBase ?? null;
  const viteOrigin = options.viteOrigin === undefined ? viteOriginFromEnv() : options.viteOrigin;
  const commentDir = options.commentDir;
  const listComments = (repo: string, branch?: string | null) =>
    listCommentsStore(repo, branch, commentDir);
  const addComment = (repo: string, data: Parameters<typeof addCommentStore>[1]) =>
    addCommentStore(repo, data, commentDir);
  const getComment = (repo: string, id: string) => getCommentStore(repo, id, commentDir);
  const updateComment = (
    repo: string,
    id: string,
    patch: Parameters<typeof updateCommentStore>[2],
  ) => updateCommentStore(repo, id, patch, commentDir);
  const deleteComment = (repo: string, id: string) => deleteCommentStore(repo, id, commentDir);
  const clearComments = (repo: string, branch?: string | null) =>
    clearCommentsStore(repo, branch, commentDir);
  const restoreCleared = (repo: string) => restoreClearedStore(repo, commentDir);
  // CLI-started default when a request omits ?repo= / body.repo / x-prequel-repo.
  // Only reachable on 127.0.0.1, but still unauthenticated.
  const defaultDisplayPath = defaultRepoRoot || process.cwd();

  // Pick the repo for this request. Query wins, then JSON body, then header.
  async function scopeFromRequest(req: Request, url: URL, body?: JsonBody): Promise<RepoScope> {
    const raw =
      trimmedString(url.searchParams.get("repo")) ||
      trimmedString(body?.repo) ||
      trimmedString(req.headers.get("x-prequel-repo"));
    if (!raw) {
      return { repoRoot: defaultRepoRoot, displayPath: defaultDisplayPath };
    }
    return resolveRepoSwitch(raw);
  }

  // A repo is required for everything comment-shaped; sample-diff mode has
  // nowhere to store comments.
  async function requireRepo(req: Request, url: URL, body?: JsonBody): Promise<RepoScope> {
    const scope = await scopeFromRequest(req, url, body);
    if (!scope.repoRoot) {
      throw new HttpError(400, "no repo");
    }
    return scope;
  }

  // --- live updates (SSE) -------------------------------------------------
  // Every mutation is broadcast so open pages reflect changes made elsewhere —
  // notably by Claude working the review through the API. Clients filter by
  // displayPath / repoRoot so tabs watching different projects stay isolated.
  interface SseClient {
    write(frame: string): void;
  }
  const sseClients = new Set<SseClient>();

  // `origin` is the client id sent by whoever made the change; that client
  // already applied it locally and skips its own echo.
  function emit(type: string, data: JsonBody, req: Request, scope: RepoScope): void {
    const frame = `data: ${JSON.stringify({
      type,
      origin: req.headers.get("x-prequel-client") || null,
      repoRoot: scope.repoRoot,
      displayPath: scope.displayPath,
      ...data,
    })}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(frame);
      } catch {
        sseClients.delete(client); // dropped connection
      }
    }
  }

  function openEventStream(req: Request): Response {
    const encoder = new TextEncoder();
    let ping: ReturnType<typeof setInterval> | null = null;
    let client: SseClient | null = null;

    const cleanup = () => {
      if (ping) {
        clearInterval(ping);
      }
      ping = null;
      if (client) {
        sseClients.delete(client);
      }
      client = null;
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const self: SseClient = {
          write(frame) {
            controller.enqueue(encoder.encode(frame));
          },
        };
        client = self;
        self.write("retry: 2000\n\n");
        sseClients.add(self);
        // Comment-only frames keep the connection from idling out.
        ping = setInterval(() => {
          try {
            self.write(": ping\n\n");
          } catch {
            cleanup();
          }
        }, 25000);
        req.signal.addEventListener("abort", cleanup);
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  // --- the review page ---------------------------------------------------
  async function renderPage(req: Request, url: URL): Promise<Response> {
    const q = url.searchParams;
    // ?view=split|unified (layout); ?mode=light|dark (color); default auto.
    const view: ViewMode = q.get("view") === "unified" ? "unified" : "split";
    const mode = q.get("mode");
    const colorMode: ColorMode = mode === "light" || mode === "dark" ? mode : "auto";
    // ?diff=all|branch|working (which changes to show); ?base=<ref>.
    // Default is `all` so "head into base" is the real comparison, not just
    // uncommitted edits vs the current branch.
    const requestedMode = q.get("diff") as DiffMode | null;
    const diffMode: DiffMode =
      requestedMode && DIFF_MODES.includes(requestedMode) ? requestedMode : DEFAULT_DIFF_MODE;
    const requestedBase = q.get("base") || defaultBase;
    const requestedHead = q.get("head");

    let repoRoot = defaultRepoRoot;
    let displayPath = defaultDisplayPath;
    let pathError: string | null = null;
    try {
      const scope = await scopeFromRequest(req, url);
      repoRoot = scope.repoRoot;
      displayPath = scope.displayPath;
    } catch (err) {
      pathError = messageOf(err);
      repoRoot = null;
      displayPath = trimmedString(q.get("repo")) || defaultDisplayPath;
    }

    let head: string | undefined = sampleDiff.head;
    let base: string | undefined = sampleDiff.base;
    let checkedOut: string | undefined;
    let branches: BranchInfo[] = [];
    let error = pathError;

    // Cheap metadata first so the header can stream before git diff + highlight.
    if (repoRoot) {
      try {
        const meta = await getCompareMeta(repoRoot, {
          base: requestedBase,
          head: requestedHead,
        });
        head = meta.head;
        base = meta.base;
        checkedOut = meta.checkedOut;
        branches = await listLocalBranches(repoRoot);
        error = pathError;
      } catch (err) {
        error = messageOf(err);
      }
    }

    const hrefWith = (updates: Record<string, string>): string => {
      const params = new URLSearchParams(url.search);
      for (const [key, value] of Object.entries(updates)) {
        params.set(key, value);
      }
      return `?${params.toString()}`;
    };
    const branchOptions = branches.map((b) => ({
      ...b,
      fetchedLabel: fetchedLabel(b.fetchedAt),
      fetchedTitle: fetchedTitle(b),
      headHref: hrefWith({ head: b.name }),
      baseHref: hrefWith({ base: b.name }),
    }));
    const headInfo = branches.find((b) => b.name === head);
    const baseInfo = branches.find((b) => b.name === base);
    const shellLocals = {
      repoPath: displayPath,
      repoName: path.basename(displayPath) || displayPath,
      isRepo: Boolean(repoRoot),
      base,
      head,
      checkedOut,
      branches: branchOptions,
      headFetchedLabel: headInfo?.fetchedAt ? fetchedLabel(headInfo.fetchedAt) : "",
      headFetchedTitle: fetchedTitle(headInfo ?? { upstream: null, fetchedAt: null }),
      baseFetchedLabel: baseInfo?.fetchedAt ? fetchedLabel(baseInfo.fetchedAt) : "",
      baseFetchedTitle: fetchedTitle(baseInfo ?? { upstream: null, fetchedAt: null }),
      diffMode,
      colorMode,
      view,
      commentsEnabled: Boolean(repoRoot),
    };

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (html: string) => controller.enqueue(encoder.encode(html));
        try {
          write(await ejs.renderFile(reviewStartTemplate, shellLocals));

          let diff: ReviewDiff | null = null;
          if (repoRoot) {
            try {
              const result = await getDiff(repoRoot, {
                base: requestedBase,
                head: requestedHead,
                mode: diffMode,
              });
              diff = parseDiff(result.patch);
              head = result.head;
              base = result.base;
              checkedOut = result.checkedOut;
              error = pathError;
            } catch (err) {
              error = messageOf(err);
            }
          }

          if (!diff) {
            // No repo (or git failed): fall back to the built-in sample so the UI
            // still demonstrates. `error` surfaces any git / path failure.
            diff = sampleDiff;
            head = head || sampleDiff.head;
            base = base || sampleDiff.base;
          }

          const renderDiffModel = await highlightDiff(annotateWordDiffs(diff));
          const headIsCheckout = Boolean(
            repoRoot && head && (head === checkedOut || head === "HEAD"),
          );
          const rev: Rev =
            repoRoot && (diffMode === "branch" || (diffMode === "all" && !headIsCheckout))
              ? head || "HEAD"
              : "WORKTREE";
          const { filesHtml, summary } = renderDiff(renderDiffModel, { view, rev });
          const treeHtml = diff.files.length ? renderFileTree(diff) : "";
          write(
            await ejs.renderFile(reviewEndTemplate, {
              ...shellLocals,
              head,
              base,
              checkedOut,
              error,
              filesHtml,
              treeHtml,
              summary,
              viteOrigin,
            }),
          );
        } catch (err) {
          write(
            `<style>#boot-panel{display:none!important}</style>` +
              `<div class="review-layout"><main class="diff-container">` +
              `<div class="notice notice-error">Could not read git diff: ${escapeHtmlText(messageOf(err))}</div>` +
              `</main></div></body></html>`,
          );
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: PAGE_HEADERS });
  }

  // --- routes ------------------------------------------------------------

  async function getBranches(req: Request, url: URL): Promise<Response> {
    const scope = await requireRepo(req, url);
    const branches = await listLocalBranches(scope.repoRoot!);
    return json({
      branches: branches.map((b) => ({
        ...b,
        fetchedLabel: fetchedLabel(b.fetchedAt),
        fetchedTitle: fetchedTitle(b),
      })),
    });
  }

  // Validate a path the UI wants to open (does not change any global state —
  // the tab then navigates with ?repo= so each tab stays independent).
  async function postRepo(req: Request): Promise<Response> {
    const body = await readJsonBody(req);
    const next = await resolveRepoSwitch(body.path);
    return json({
      ok: true,
      repoRoot: next.repoRoot,
      displayPath: next.displayPath,
      isRepo: Boolean(next.repoRoot),
    });
  }

  // On-demand context lines for hunk expansion.
  // ?path=&rev=WORKTREE|<git-rev>&start=&end= (new-side line numbers, 1-based).
  async function getContext(req: Request, url: URL): Promise<Response> {
    const scope = await requireRepo(req, url);
    const q = url.searchParams;
    const filePath = q.get("path") || "";
    const rawRev = q.get("rev") || "";
    const start = parseInt(q.get("start") ?? "", 10);
    const end = parseInt(q.get("end") ?? "", 10);
    if (!filePath || !Number.isFinite(start) || !Number.isFinite(end)) {
      throw new HttpError(400, "bad params");
    }
    let rev: Rev;
    if (rawRev === "WORKTREE") {
      rev = "WORKTREE";
    } else {
      const resolved = await resolveCompareRef(scope.repoRoot!, rawRev);
      if (!resolved) {
        throw new HttpError(400, "bad rev");
      }
      rev = resolved;
    }
    const { lines, from, eof } = await getBlobLines(scope.repoRoot!, {
      rev,
      path: filePath,
      start,
      end,
    });
    const html = await highlightLines(lines, inferLanguage(filePath));
    return json({ from, eof, lines, html });
  }

  // Read-only: line-anchored review comments from this branch's open PR
  // (GitHub via `gh`, or Forgejo/Gitea via the push remote's HTTP API).
  async function getPrComments(req: Request, url: URL): Promise<Response> {
    const scope = await requireRepo(req, url);
    const repoRoot = scope.repoRoot!;
    const branch = trimmedString(url.searchParams.get("branch"));
    if (!branch) {
      throw new HttpError(400, "branch required");
    }
    if (!isSafeRefName(branch)) {
      throw new HttpError(400, "unsafe branch name");
    }
    // A passed ghHost (e.g. a GHE hostname) is remembered per repo so it only
    // has to be typed once; omit it to reuse whatever was last saved.
    const rawHost = trimmedString(url.searchParams.get("ghHost"));
    if (rawHost) {
      if (!isSafeGhHost(rawHost)) {
        throw new HttpError(400, "invalid GitHub host");
      }
      await setGhHost(repoRoot, rawHost, commentDir);
    }
    const rawToken = trimmedString(url.searchParams.get("forgeToken"));
    if (rawToken) {
      if (!isSafeForgeToken(rawToken)) {
        throw new HttpError(400, "invalid Forgejo token");
      }
      await setForgeToken(repoRoot, rawToken, commentDir);
    }
    const ghHost = rawHost || (await getGhHost(repoRoot, commentDir));
    const forgeToken = rawToken || (await getForgeToken(repoRoot, commentDir));
    const { threads, provider } = await fetchPrReviewComments(repoRoot, branch, {
      ghHost,
      forgeToken,
    });
    return json({ threads, provider, ghHost });
  }

  // Push one local line comment to the open Forgejo/Gitea PR (not GitHub).
  // The local comment stays the source of truth; this only mirrors it upstream.
  async function postPrCommentPush(req: Request, url: URL): Promise<Response> {
    const body = await readJsonBody(req);
    const scope = await requireRepo(req, url, body);
    const repoRoot = scope.repoRoot!;
    const commentId = trimmedString(body.commentId);
    if (!commentId) {
      throw new HttpError(400, "commentId required");
    }
    const comment = await getComment(repoRoot, commentId);
    if (!comment) {
      throw new HttpError(404, "not found");
    }
    if (comment.parentId) {
      throw new HttpError(400, "post root comments only");
    }
    if (comment.side !== "old" && comment.side !== "new") {
      throw new HttpError(400, "only line comments can be posted to a PR");
    }
    const branch = (comment.branch && comment.branch.trim()) || trimmedString(body.branch) || null;
    if (!branch) {
      throw new HttpError(400, "branch required");
    }
    if (!isSafeRefName(branch)) {
      throw new HttpError(400, "unsafe branch name");
    }

    const rawToken = trimmedString(body.forgeToken);
    if (rawToken) {
      if (!isSafeForgeToken(rawToken)) {
        throw new HttpError(400, "invalid Forgejo token");
      }
      await setForgeToken(repoRoot, rawToken, commentDir);
    }
    const forgeToken = rawToken || (await getForgeToken(repoRoot, commentDir));
    const ghHost = await getGhHost(repoRoot, commentDir);
    const line = Math.max(comment.startLine, comment.endLine);
    const result = await pushLocalCommentToPr(
      repoRoot,
      branch,
      {
        path: comment.filePath,
        side: comment.side,
        line,
        body: comment.body,
      },
      { forgeToken, ghHost },
    );
    return json({ ok: true, ...result });
  }

  async function getCommentList(req: Request, url: URL): Promise<Response> {
    const scope = await scopeFromRequest(req, url);
    if (!scope.repoRoot) {
      return json({ comments: [] });
    }
    const q = url.searchParams;
    const branch = q.get("branch") || null;
    // Optional filters; omit them all to get everything (what the UI wants).
    //   ?status=open|resolved   ?author=user|claude   ?roots=1 (exclude replies)
    const rawStatus = q.get("status");
    const status: CommentStatus | null =
      rawStatus === "open" || rawStatus === "resolved" ? rawStatus : null;
    const rawAuthor = q.get("author");
    const author: CommentAuthor | null =
      rawAuthor === "user" || rawAuthor === "claude" ? rawAuthor : null;
    const rootsOnly = q.get("roots") === "1";

    let comments = await listComments(scope.repoRoot, branch);
    // Comments predating these fields are treated as open, user-authored roots.
    if (status) {
      comments = comments.filter((c) => (c.status || "open") === status);
    }
    if (author) {
      comments = comments.filter((c) => (c.author || "user") === author);
    }
    if (rootsOnly) {
      comments = comments.filter((c) => !c.parentId);
    }
    return json({ comments: comments.map(withHtml) });
  }

  async function postComment(req: Request, url: URL): Promise<Response> {
    const body = await readJsonBody(req);
    const scope = await requireRepo(req, url, body);
    const repoRoot = scope.repoRoot!;
    const author: CommentAuthor = body.author === "claude" ? "claude" : "user";

    // A reply carries only { parentId, body } — it inherits its anchor from the
    // comment it answers, so the two can never drift apart.
    if (body.parentId) {
      const parent = await getComment(repoRoot, String(body.parentId));
      if (!parent) {
        throw new HttpError(404, "parent not found");
      }
      if (parent.parentId) {
        throw new HttpError(400, "cannot reply to a reply");
      }
      if (!body.body) {
        throw new HttpError(400, "bad params");
      }
      const reply = await addComment(repoRoot, {
        parentId: parent.id,
        author,
        filePath: parent.filePath,
        side: parent.side,
        startLine: parent.startLine,
        endLine: parent.endLine,
        body: String(body.body),
        branch: parent.branch ?? null,
        lineSnapshot: [],
      });
      emit("comment.created", { comment: withHtml(reply) }, req, scope);
      return json({ comment: withHtml(reply) });
    }

    const side: CommentSide = body.side === "old" ? "old" : body.side === "file" ? "file" : "new";
    // file-level comments aren't tied to a line
    const startLine = side === "file" ? 0 : Number(body.startLine);
    if (!body.filePath || !body.body || (side !== "file" && !Number.isFinite(startLine))) {
      throw new HttpError(400, "bad params");
    }
    const endLine = Number(body.endLine);
    const comment = await addComment(repoRoot, {
      filePath: String(body.filePath),
      side,
      startLine,
      endLine:
        side === "file" ? 0 : Number.isFinite(endLine) ? Math.max(endLine, startLine) : startLine,
      body: String(body.body),
      branch: body.branch ? String(body.branch) : null,
      lineSnapshot: Array.isArray(body.lineSnapshot) ? body.lineSnapshot.map(String) : [],
      author,
      parentId: null,
    });
    emit("comment.created", { comment: withHtml(comment) }, req, scope);
    return json({ comment: withHtml(comment) });
  }

  async function patchComment(req: Request, url: URL, id: string): Promise<Response> {
    const body = await readJsonBody(req);
    const scope = await requireRepo(req, url, body);
    const patch: { body?: string; status?: CommentStatus } = {};
    if (typeof body.body === "string") {
      patch.body = body.body;
    }
    if (body.status === "open" || body.status === "resolved") {
      patch.status = body.status;
    }
    const comment = await updateComment(scope.repoRoot!, id, patch);
    if (!comment) {
      throw new HttpError(404, "not found");
    }
    emit("comment.updated", { comment: withHtml(comment) }, req, scope);
    return json({ comment: withHtml(comment) });
  }

  async function removeComment(req: Request, url: URL, id: string): Promise<Response> {
    const scope = await requireRepo(req, url);
    const removed = await deleteComment(scope.repoRoot!, id);
    if (removed) {
      emit("comment.deleted", { id }, req, scope);
    }
    return json({ ok: Boolean(removed), removed });
  }

  // Bulk clear (with undo) for a clean slate between review rounds.
  async function postClear(req: Request, url: URL): Promise<Response> {
    const body = await readJsonBody(req);
    const scope = await requireRepo(req, url, body);
    const branch = body.branch ? String(body.branch) : null;
    const cleared = await clearComments(scope.repoRoot!, branch);
    emit("comments.reset", {}, req, scope);
    return json({ cleared });
  }

  async function postRestore(req: Request, url: URL): Promise<Response> {
    const body = await readJsonBody(req);
    const scope = await requireRepo(req, url, body);
    const restored = await restoreCleared(scope.repoRoot!);
    emit("comments.reset", {}, req, scope);
    return json({ restored });
  }

  // Build the Claude payload, write it to <repo>/.prequel/, and return it so the
  // client can also copy it to the clipboard.
  async function postExport(req: Request, url: URL): Promise<Response> {
    const body = await readJsonBody(req);
    const scope = await requireRepo(req, url, body);
    const repoRoot = scope.repoRoot!;
    const branch = body.branch ? String(body.branch) : null;
    const format = body.format === "json" ? "json" : "md";
    // Replies (and anything Claude wrote) are conversation, not asks — the
    // export is the list of things being requested.
    const all = await listComments(repoRoot, branch);
    const comments = all.filter(
      (c) => !c.parentId && (c.author || "user") === "user" && (c.status || "open") === "open",
    );
    if (!comments.length) {
      return json({ count: 0, content: "", path: null });
    }

    const content =
      format === "json" ? buildJson(comments) : buildMarkdown(repoRoot, branch, comments);
    // filesystem-safe timestamp: 2026-07-17-16-40-00
    const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const dir = path.join(repoRoot, ".prequel");
    const filename = `review-${ts}.${format}`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), content);
    await ensureExcluded(repoRoot); // keep .prequel/ out of the diff & commits
    return json({ count: comments.length, content, path: path.join(".prequel", filename) });
  }

  // Identifies this server. Pass ?repo=<path> to confirm it can serve that path
  // (needed when one process backs multiple browser tabs / projects).
  async function healthz(url: URL): Promise<Response> {
    const requested = trimmedString(url.searchParams.get("repo"));
    if (requested) {
      try {
        const scope = await resolveRepoSwitch(requested);
        return json({
          ok: true,
          app: "prequel",
          repoRoot: scope.repoRoot,
          displayPath: scope.displayPath,
        });
      } catch (err) {
        return json({ ok: false, app: "prequel", error: messageOf(err) }, statusOf(err));
      }
    }
    return json({
      ok: true,
      app: "prequel",
      repoRoot: defaultRepoRoot,
      displayPath: defaultDisplayPath,
    });
  }

  // Route table, mirroring the pre-Bun Express layout.
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    try {
      if (method === "POST" || method === "PATCH" || method === "DELETE") {
        assertSameOrigin(req);
      }

      if (method === "GET" || method === "HEAD") {
        if (pathname === "/") {
          return await renderPage(req, url);
        }
        if (pathname === "/healthz") {
          return await healthz(url);
        }
        if (pathname === "/api/events") {
          return openEventStream(req);
        }
        if (pathname === "/api/context") {
          return await getContext(req, url);
        }
        if (pathname === "/api/branches") {
          return await getBranches(req, url);
        }
        if (pathname === "/api/comments") {
          return await getCommentList(req, url);
        }
        if (pathname === "/api/pr-comments") {
          return await getPrComments(req, url);
        }
        if (pathname.startsWith("/static/")) {
          return await serveStatic(publicDir, pathname.slice("/static/".length));
        }
        if (pathname.startsWith("/vendor/primer/")) {
          return await serveStatic(primerCssDir, pathname.slice("/vendor/primer/".length));
        }
      }

      if (method === "POST") {
        if (pathname === "/api/repo") {
          return await postRepo(req);
        }
        if (pathname === "/api/comments") {
          return await postComment(req, url);
        }
        if (pathname === "/api/comments/clear") {
          return await postClear(req, url);
        }
        if (pathname === "/api/comments/restore") {
          return await postRestore(req, url);
        }
        if (pathname === "/api/export") {
          return await postExport(req, url);
        }
        if (pathname === "/api/pr-comments/push") {
          return await postPrCommentPush(req, url);
        }
      }

      if (method === "PATCH" || method === "DELETE") {
        const id = commentIdFrom(pathname);
        if (id) {
          return method === "PATCH"
            ? await patchComment(req, url, id)
            : await removeComment(req, url, id);
        }
      }

      return text("Not found", 404);
    } catch (err) {
      if (pathname.startsWith("/api/")) {
        return apiError(err);
      }
      // Page routes surface their own failures inline; anything reaching here
      // is unexpected, so log it and keep the response opaque.
      process.stderr.write(`prequel ${method} ${pathname} failed: ${messageOf(err)}\n`);
      return text("Internal error", statusOf(err));
    }
  };
}

// /api/comments/<id> — but not the /clear and /restore actions.
function commentIdFrom(pathname: string): string | null {
  const prefix = "/api/comments/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const rest = pathname.slice(prefix.length);
  if (!rest || rest.includes("/")) {
    return null;
  }
  try {
    return decodeURIComponent(rest) || null;
  } catch {
    return null;
  }
}

export interface StartOptions extends ServerOptions {
  port: number;
  hostname?: string;
}

/** Bind the app to a port. Loopback-only by default, as the API is unauthenticated. */
export function startServer({ port, hostname = "127.0.0.1", ...options }: StartOptions) {
  const app = createApp(options);
  return Bun.serve({
    port,
    hostname,
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch: app,
    error(err) {
      // Don't hand internals to the browser; the operator gets the detail.
      process.stderr.write(`prequel request failed: ${err.message}\n`);
      return new Response("Internal error", { status: 500 });
    },
  });
}
