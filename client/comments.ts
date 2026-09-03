// Review comments: hover-"+" for a line comment (or the file-header button for
// a file-level comment), save, render as inline threads, delete. Plus bulk
// clear (with undo) and export-then-clear, for the review→hand-off→re-review loop.

import type { Comment, CommentSide } from "../src/comments/commentStore";
import type { PrCommentThread } from "../src/git/prComments";
import { closestFrom, escapeHtml, withRepoQuery } from "./dom";

/** A comment as the API returns it (body plus rendered markdown). */
type UiComment = Comment & { bodyHtml: string };

interface EventBase {
  origin: string | null;
  repoRoot: string | null;
  displayPath: string | null;
}

type ServerEvent =
  | (EventBase & { type: "comment.created" | "comment.updated"; comment: UiComment })
  | (EventBase & { type: "comment.deleted"; id: string })
  | (EventBase & { type: "comments.reset" });

const root = document.documentElement;
const commentsEnabled = root.dataset.commentsEnabled === "1";
const branch = root.dataset.branch ?? "";
const pageRepo = root.dataset.repo ?? "";

const exportBtn = document.getElementById("export-btn") as HTMLButtonElement | null;
const clearBtn = document.getElementById("clear-btn") as HTMLButtonElement | null;
const importPrBtn = document.getElementById("import-pr-btn") as HTMLButtonElement | null;
let commentCount = 0;

const isSplitTable = (table: Element | null): boolean =>
  table?.classList.contains("diff-table-split") ?? false;

// Identifies this tab so it can ignore the echo of its own mutations coming
// back over the event stream (it already applied them locally).
const CLIENT_ID = crypto.randomUUID?.() ?? String(Math.random());
const jsonHeaders = () => ({ "content-type": "application/json", "x-prequel-client": CLIENT_ID });
const clientHeaders = () => ({ "x-prequel-client": CLIENT_ID });

function eventTargetsThisTab(msg: EventBase): boolean {
  if (!msg.repoRoot && !msg.displayPath) {
    return true;
  }
  return msg.displayPath === pageRepo || msg.repoRoot === pageRepo;
}

// --- subnav buttons ----------------------------------------------------
function updateButtons(): void {
  if (exportBtn) {
    exportBtn.hidden = commentCount === 0;
    exportBtn.textContent =
      commentCount === 1
        ? "Export 1 comment for Claude"
        : `Export ${commentCount} comments for Claude`;
  }
  if (clearBtn) {
    clearBtn.hidden = commentCount === 0;
  }
}

// --- toast (with optional action) --------------------------------------
interface ToastAction {
  label: string;
  fn: () => void;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function toast(message: string, action?: ToastAction): void {
  const el = document.getElementById("toast");
  if (!el) {
    return;
  }
  el.textContent = "";
  const span = document.createElement("span");
  span.textContent = message;
  el.appendChild(span);
  if (action) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      el.hidden = true;
      action.fn();
    });
    el.appendChild(btn);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}

// --- shared thread markup ---------------------------------------------
// A thread is one root comment plus its replies, rendered as stacked cards
// inside a single container — the shape GitHub uses.
function timeLabel(c: UiComment): string {
  try {
    return new Date(c.createdAt).toLocaleString();
  } catch {
    return "";
  }
}

function commentCardHtml(c: UiComment, { isRoot }: { isRoot: boolean }): string {
  const author = c.author === "claude" ? "claude" : "you";
  const range =
    isRoot && c.side !== "file" && c.endLine > c.startLine
      ? `<span class="comment-lines">Lines ${c.startLine}–${c.endLine}</span>`
      : "";
  const resolved = isRoot && c.status === "resolved";
  const canPost =
    isRoot &&
    !resolved &&
    (c.side === "old" || c.side === "new") &&
    (c.author || "user") === "user";
  const tools = isRoot
    ? `<button class="comment-resolve">${resolved ? "Reopen" : "Resolve"}</button>` +
      `<button class="comment-reply-btn">Reply</button>` +
      (canPost ? `<button type="button" class="comment-post-pr-btn">Post to PR</button>` : "")
    : "";
  return (
    `<div class="comment" data-comment-id="${c.id}" data-author="${author}">` +
    `<div class="comment-header">` +
    `<span class="comment-author comment-author-${author}">${author === "claude" ? "Claude" : "You"}</span>` +
    range +
    `<span class="comment-time">${escapeHtml(timeLabel(c))}</span>` +
    (resolved ? '<span class="comment-resolved-pill">Resolved</span>' : "") +
    `<span class="comment-tools">${tools}` +
    `<button class="comment-delete" title="Delete comment">Delete</button></span>` +
    `</div>` +
    `<div class="comment-body markdown-body">${c.bodyHtml || escapeHtml(c.body || "")}</div>` +
    `</div>`
  );
}

function threadInner(rootComment: UiComment, replies?: UiComment[]): string {
  const cards = [commentCardHtml(rootComment, { isRoot: true })].concat(
    (replies ?? []).map((r) => commentCardHtml(r, { isRoot: false })),
  );
  const cls = rootComment.status === "resolved" ? " is-resolved" : "";
  return `<div class="comment-thread${cls}" data-root-id="${rootComment.id}">${cards.join("")}</div>`;
}

function composeInner(): string {
  return (
    `<form class="comment-compose">` +
    `<textarea class="comment-input" rows="3" placeholder="Leave a comment. Markdown supported."></textarea>` +
    `<div class="comment-compose-actions">` +
    `<button type="button" class="btn comment-cancel">Cancel</button>` +
    `<button type="submit" class="btn btn-primary">Comment</button>` +
    `</div></form>`
  );
}

// Unified spans the code column (colspan 3); split confines the thread to the
// side it was made on (2 of 4 columns), leaving the other side empty.
function threadCells(isSplit: boolean, side: CommentSide, inner: string): string {
  if (!isSplit) {
    return `<td class="comment-cell" colspan="3">${inner}</td>`;
  }
  const cell = `<td class="comment-cell" colspan="2">${inner}</td>`;
  const empty = '<td class="comment-cell-empty" colspan="2"></td>';
  return side === "old" ? cell + empty : empty + cell;
}

const commentRowHtml = (c: UiComment, isSplit: boolean, replies?: UiComment[]): string =>
  `<tr class="comment-row" data-root-id="${c.id}">${threadCells(isSplit, c.side, threadInner(c, replies))}</tr>`;
const fileCommentHtml = (c: UiComment, replies?: UiComment[]): string =>
  `<div class="file-comment" data-root-id="${c.id}">${threadInner(c, replies)}</div>`;

// --- anchoring helpers -------------------------------------------------
function findAnchorCell(filePath: string, side: string, line: number): HTMLElement | null {
  const file = document.querySelector(`.file[data-path="${CSS.escape(filePath)}"]`);
  if (!file) {
    return null;
  }
  return file.querySelector<HTMLElement>(
    `.blob-num.commentable[data-side="${side}"][data-comment-line="${line}"]`,
  );
}

// The code cell that belongs to a gutter cell (same row, next .blob-code).
function codeCellFor(gutterCell: HTMLElement): Element | null {
  const row = gutterCell.closest("tr");
  if (!row) {
    return null;
  }
  const cells = [...row.children];
  const start = cells.indexOf(gutterCell);
  for (let i = start + 1; i < cells.length; i++) {
    if (cells[i]!.classList.contains("blob-code")) {
      return cells[i]!;
    }
  }
  return null;
}

function snapshotFor(gutterCell: HTMLElement): string {
  const code = codeCellFor(gutterCell);
  const inner = code?.querySelector(".blob-code-inner");
  return inner ? (inner.textContent ?? "").slice(1) : ""; // drop the +/-/space marker
}

// Capture every line's code across a range on one side (for export context).
function snapshotForRange(filePath: string, side: string, lo: number, hi: number): string[] {
  const out: string[] = [];
  for (let n = lo; n <= hi; n++) {
    const cell = findAnchorCell(filePath, side, n);
    if (cell) {
      out.push(snapshotFor(cell));
    }
  }
  return out.length ? out : [""];
}

// Tint the selected line range (gutter + code) while composing / dragging.
function clearRangeHighlight(): void {
  document.querySelectorAll(".mq-range-line").forEach((el) => el.classList.remove("mq-range-line"));
}

function highlightRange(filePath: string, side: string, lo: number, hi: number): void {
  clearRangeHighlight();
  if (hi <= lo) {
    return;
  }
  for (let n = lo; n <= hi; n++) {
    const g = findAnchorCell(filePath, side, n);
    if (!g) {
      continue;
    }
    g.classList.add("mq-range-line");
    codeCellFor(g)?.classList.add("mq-range-line");
  }
}

function insertionPointAfter(row: Element): Element {
  let last = row;
  while (last.nextElementSibling?.classList.contains("comment-row")) {
    last = last.nextElementSibling;
  }
  return last;
}

// --- composing ---------------------------------------------------------
// Single line = range where start === end. The thread is anchored after the
// END line (GitHub's convention), and the snapshot captures the whole block.
function openLineCompose(filePath: string, side: CommentSide, a: number, b: number): void {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);

  // Re-focus if the identical range is already being composed.
  const same = [...document.querySelectorAll<HTMLElement>(".comment-compose-row")].find(
    (r) =>
      r.dataset.filePath === filePath &&
      r.dataset.side === side &&
      Number(r.dataset.startLine) === lo &&
      Number(r.dataset.endLine) === hi,
  );
  if (same) {
    same.querySelector<HTMLTextAreaElement>(".comment-input")?.focus();
    return;
  }

  // Otherwise replace any open line-compose and (re)highlight this range.
  document.querySelectorAll(".comment-compose-row").forEach((r) => r.remove());
  const cell = findAnchorCell(filePath, side, hi);
  if (!cell) {
    clearRangeHighlight();
    return;
  }

  const isSplit = isSplitTable(cell.closest("table"));
  const at = insertionPointAfter(cell.closest("tr")!);
  at.insertAdjacentHTML(
    "afterend",
    `<tr class="comment-row comment-compose-row">${threadCells(isSplit, side, composeInner())}</tr>`,
  );
  const composeRow = at.nextElementSibling as HTMLElement | null;
  if (!composeRow) {
    return;
  }
  Object.assign(composeRow.dataset, {
    filePath,
    side,
    startLine: String(lo),
    endLine: String(hi),
    snapshot: JSON.stringify(snapshotForRange(filePath, side, lo, hi)),
  });
  setFormContext(composeRow);
  highlightRange(filePath, side, lo, hi);
  composeRow.querySelector<HTMLTextAreaElement>(".comment-input")?.focus();
}

function openFileCompose(fileEl: HTMLElement): void {
  const filePath = fileEl.dataset.path ?? "";
  const container = fileEl.querySelector(".file-comments");
  if (!container) {
    return;
  }
  let compose = container.querySelector<HTMLElement>(".file-comment-compose");
  if (!compose) {
    container.insertAdjacentHTML(
      "beforeend",
      `<div class="file-comment-compose">${composeInner()}</div>`,
    );
    compose = container.querySelector<HTMLElement>(".file-comment-compose");
    if (!compose) {
      return;
    }
    Object.assign(compose.dataset, {
      filePath,
      side: "file",
      startLine: "0",
      endLine: "0",
      snapshot: "[]",
    });
    setFormContext(compose);
  }
  compose.querySelector<HTMLTextAreaElement>(".comment-input")?.focus();
}

// Copy anchor context onto the form so submit is container-agnostic.
function setFormContext(container: HTMLElement): void {
  const form = container.querySelector<HTMLFormElement>(".comment-compose");
  if (!form) {
    return;
  }
  Object.assign(form.dataset, {
    filePath: container.dataset.filePath,
    side: container.dataset.side,
    startLine: container.dataset.startLine,
    endLine: container.dataset.endLine,
    snapshot: container.dataset.snapshot,
  });
}

function setButtonsDisabled(form: HTMLFormElement, disabled: boolean): void {
  form.querySelectorAll("button").forEach((b) => (b.disabled = disabled));
}

async function submitCompose(form: HTMLFormElement): Promise<void> {
  const container = form.closest<HTMLElement>(".comment-compose-row, .file-comment-compose");
  const input = form.querySelector<HTMLTextAreaElement>(".comment-input");
  const body = input?.value.trim();
  if (!body || !container) {
    return;
  }
  setButtonsDisabled(form, true);
  try {
    const res = await fetch(withRepoQuery("/api/comments"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        filePath: form.dataset.filePath,
        side: form.dataset.side,
        startLine: Number(form.dataset.startLine),
        endLine: Number(form.dataset.endLine),
        body,
        branch,
        lineSnapshot: JSON.parse(form.dataset.snapshot || "[]") as string[],
      }),
    });
    const { comment } = (await res.json()) as { comment: UiComment };
    if (comment.side === "file") {
      container.outerHTML = fileCommentHtml(comment);
    } else {
      const isSplit = isSplitTable(container.closest("table"));
      container.insertAdjacentHTML("afterend", commentRowHtml(comment, isSplit));
      container.remove();
    }
    clearRangeHighlight();
    commentCount++;
    updateButtons();
  } catch {
    setButtonsDisabled(form, false);
  }
}

// Removing a root takes the whole thread (the server cascades its replies);
// removing a reply takes just that card.
function dropComment(id: string): void {
  const container = document.querySelector(`[data-root-id="${CSS.escape(id)}"]`);
  if (container) {
    container.remove();
    commentCount = Math.max(0, commentCount - 1);
    updateButtons();
    return;
  }
  document.querySelector(`.comment[data-comment-id="${CSS.escape(id)}"]`)?.remove();
}

async function removeComment(card: HTMLElement): Promise<void> {
  const id = card.dataset.commentId;
  if (!id) {
    return;
  }
  try {
    await fetch(withRepoQuery(`/api/comments/${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers: clientHeaders(),
    });
    dropComment(id);
  } catch {
    /* leave it in place on failure */
  }
}

async function setStatus(id: string, status: "open" | "resolved"): Promise<void> {
  try {
    const res = await fetch(withRepoQuery(`/api/comments/${encodeURIComponent(id)}`), {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ status }),
    });
    const { comment } = (await res.json()) as { comment: UiComment };
    applyStatus(comment);
  } catch {
    /* leave the UI as-is on failure */
  }
}

// Repaint a root card in place so its pill and Resolve/Reopen label match.
function applyStatus(c: UiComment): void {
  const card = document.querySelector(`.comment[data-comment-id="${CSS.escape(c.id)}"]`);
  if (!card) {
    return;
  }
  const thread = card.closest<HTMLElement>(".comment-thread");
  const isRoot = thread?.dataset.rootId === c.id;
  card.outerHTML = commentCardHtml(c, { isRoot: Boolean(isRoot) });
  if (isRoot && thread) {
    thread.classList.toggle("is-resolved", c.status === "resolved");
  }
}

async function submitReply(form: HTMLFormElement): Promise<void> {
  const thread = form.closest<HTMLElement>(".comment-thread");
  const input = form.querySelector<HTMLTextAreaElement>(".comment-input");
  const body = input?.value.trim();
  if (!body || !thread) {
    return;
  }
  setButtonsDisabled(form, true);
  try {
    const res = await fetch(withRepoQuery("/api/comments"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ parentId: thread.dataset.rootId, body }),
    });
    const { comment } = (await res.json()) as { comment: UiComment };
    form.closest(".comment-reply-compose")?.remove();
    thread.insertAdjacentHTML("beforeend", commentCardHtml(comment, { isRoot: false }));
  } catch {
    setButtonsDisabled(form, false);
  }
}

// --- load, export, clear ----------------------------------------------
function renderComment(c: UiComment, replies?: UiComment[]): void {
  if (c.side === "file") {
    const file = document.querySelector(`.file[data-path="${CSS.escape(c.filePath)}"]`);
    file
      ?.querySelector(".file-comments")
      ?.insertAdjacentHTML("beforeend", fileCommentHtml(c, replies));
    return;
  }
  // ranges anchor after the end line (GitHub's convention)
  const cell = findAnchorCell(c.filePath, c.side, c.endLine || c.startLine);
  if (!cell) {
    return;
  } // line not present in the current view/mode
  const row = cell.closest("tr");
  if (!row) {
    return;
  }
  const isSplit = isSplitTable(cell.closest("table"));
  insertionPointAfter(row).insertAdjacentHTML("afterend", commentRowHtml(c, isSplit, replies));
}

interface Thread {
  root: UiComment;
  replies: UiComment[];
}

// Replies arrive as flat records; bucket them under the root they answer.
function groupThreads(comments: UiComment[]): Thread[] {
  const roots = comments.filter((c) => !c.parentId);
  const byParent = new Map<string, UiComment[]>();
  for (const c of comments) {
    if (!c.parentId) {
      continue;
    }
    if (!byParent.has(c.parentId)) {
      byParent.set(c.parentId, []);
    }
    byParent.get(c.parentId)!.push(c);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }
  return roots.map((rootComment) => ({
    root: rootComment,
    replies: byParent.get(rootComment.id) ?? [],
  }));
}

async function loadComments(): Promise<void> {
  const loadingEl = document.getElementById("comments-loading");
  if (loadingEl) {
    loadingEl.hidden = false;
  }
  let comments: UiComment[] = [];
  try {
    const res = await fetch(withRepoQuery(`/api/comments?branch=${encodeURIComponent(branch)}`));
    ({ comments } = (await res.json()) as { comments: UiComment[] });
    const threads = groupThreads(comments);
    commentCount = threads.length; // the button counts asks, not messages
    updateButtons();
    threads.forEach(({ root: rootComment, replies }) => renderComment(rootComment, replies));
  } catch {
    /* leave the page comment-less on failure */
  } finally {
    if (loadingEl) {
      loadingEl.hidden = true;
    }
  }
}

// --- imported PR review comments (read-only context) -------------------
// Not persisted as prequel Comments: they're fetched fresh each click and
// exist only in the DOM. "Reply locally" opens the normal compose box at the
// same line, which posts a normal local comment — nothing is sent to the forge.
function prThreadHtml(t: PrCommentThread, provider: "github" | "forgejo"): string {
  const badge = provider === "forgejo" ? "Forgejo review comment" : "GitHub review comment";
  const cards = t.comments
    .map(
      (c) =>
        `<div class="pr-comment">` +
        `<div class="pr-comment-header">` +
        `<span class="pr-comment-author">${escapeHtml(c.author)}</span>` +
        `<span class="comment-time">${escapeHtml(new Date(c.createdAt).toLocaleString())}</span>` +
        `</div>` +
        `<div class="pr-comment-body">${escapeHtml(c.body)}</div>` +
        `</div>`,
    )
    .join("");
  return (
    `<div class="pr-comment-thread" data-pr-path="${escapeHtml(t.path)}" data-pr-side="${t.side}" data-pr-line="${t.line}">` +
    `<div class="pr-comment-badge">${badge}</div>` +
    cards +
    `<button type="button" class="pr-comment-reply-btn">Reply locally</button>` +
    `</div>`
  );
}

// The diff body streams in after the header; anchoring against it before it
// exists silently finds nothing (findAnchorCell returns null). Wait it out.
function waitForDiffReady(): Promise<void> {
  if (!root.classList.contains("is-booting")) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      if (!root.classList.contains("is-booting")) {
        obs.disconnect();
        resolve();
      }
    });
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
  });
}

function renderPrThread(t: PrCommentThread, provider: "github" | "forgejo"): void {
  const cell = findAnchorCell(t.path, t.side, t.line);
  if (!cell) {
    return;
  } // line not present in the current diff view/mode
  const row = cell.closest("tr");
  if (!row) {
    return;
  }
  const isSplit = isSplitTable(cell.closest("table"));
  const html = `<tr class="comment-row pr-comment-row">${threadCells(isSplit, t.side, prThreadHtml(t, provider))}</tr>`;
  insertionPointAfter(row).insertAdjacentHTML("afterend", html);
}

// Remembered for the rest of this page load once the server confirms it (it
// also persists server-side per repo, so a later session skips the prompt).
let ghHost: string | null = null;

async function runImportPr(opts?: { ghHost?: string; forgeToken?: string }): Promise<void> {
  if (!importPrBtn) {
    return;
  }
  importPrBtn.disabled = true;
  importPrBtn.classList.add("is-busy");
  document.querySelectorAll(".pr-comment-row").forEach((el) => el.remove());
  try {
    const params = new URLSearchParams({ branch });
    const host = opts?.ghHost ?? ghHost;
    if (host) {
      params.set("ghHost", host);
    }
    if (opts?.forgeToken) {
      params.set("forgeToken", opts.forgeToken);
    }
    const res = await fetch(withRepoQuery(`/api/pr-comments?${params}`));
    const data = (await res.json()) as {
      threads?: PrCommentThread[];
      provider?: "github" | "forgejo";
      ghHost?: string;
      error?: string;
      needs?: "forgeToken" | "ghHost";
    };
    if (!res.ok) {
      if (data.needs === "forgeToken") {
        toast(data.error || "Forgejo token required.", {
          label: "Set Forgejo token…",
          fn: () => {
            const entered = window.prompt("Forgejo / Gitea personal access token:");
            if (entered?.trim()) {
              void runImportPr({ forgeToken: entered.trim() });
            }
          },
        });
        return;
      }
      toast(data.error || "Could not load PR comments.", {
        label: "Set GH host…",
        fn: () => {
          const entered = window.prompt("GitHub Enterprise hostname (e.g. github.example.com):");
          if (entered?.trim()) {
            void runImportPr({ ghHost: entered.trim() });
          }
        },
      });
      return;
    }
    if (data.ghHost) {
      ghHost = data.ghHost;
    }
    const provider = data.provider === "forgejo" ? "forgejo" : "github";
    const threads = data.threads ?? [];
    if (!threads.length) {
      toast("No PR review comments found for this branch.");
      return;
    }
    await waitForDiffReady();
    threads.forEach((t) => renderPrThread(t, provider));
    toast(`Imported ${threads.length} PR comment${threads.length === 1 ? "" : "s"}.`);
  } catch {
    toast("Could not load PR comments.");
  } finally {
    importPrBtn.disabled = false;
    importPrBtn.classList.remove("is-busy");
  }
}

async function runPostToPr(commentId: string, forgeToken?: string): Promise<void> {
  const btn = document.querySelector<HTMLButtonElement>(
    `.comment[data-comment-id="${CSS.escape(commentId)}"] .comment-post-pr-btn`,
  );
  if (btn) {
    btn.disabled = true;
  }
  try {
    const res = await fetch(withRepoQuery("/api/pr-comments/push"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        commentId,
        branch: branch || undefined,
        ...(forgeToken ? { forgeToken } : {}),
      }),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      htmlUrl?: string;
      pullNumber?: number;
      error?: string;
      needs?: "forgeToken";
    };
    if (!res.ok) {
      if (data.needs === "forgeToken") {
        toast(data.error || "Forgejo token required.", {
          label: "Set Forgejo token…",
          fn: () => {
            const entered = window.prompt("Forgejo / Gitea personal access token:");
            if (entered?.trim()) {
              void runPostToPr(commentId, entered.trim());
            }
          },
        });
        return;
      }
      toast(data.error || "Could not post comment to PR.");
      return;
    }
    toast(
      data.pullNumber ? `Posted to PR #${data.pullNumber}.` : "Posted comment to PR.",
      data.htmlUrl
        ? {
            label: "Open",
            fn: () => {
              window.open(data.htmlUrl, "_blank", "noopener,noreferrer");
            },
          }
        : undefined,
    );
  } catch {
    toast("Could not post comment to PR.");
  } finally {
    if (btn) {
      btn.disabled = false;
    }
  }
}

async function runExport(): Promise<void> {
  if (commentCount === 0 || !exportBtn) {
    return;
  }
  exportBtn.disabled = true;
  exportBtn.classList.add("is-busy");
  try {
    const res = await fetch(withRepoQuery("/api/export"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ branch, format: "md" }),
    });
    const data = (await res.json()) as { count: number; content: string; path: string | null };
    if (!data.count) {
      toast("No comments to export.");
      return;
    }
    let copied = false;
    try {
      await navigator.clipboard.writeText(data.content);
      copied = true;
    } catch {
      /* clipboard may be blocked; the file write still succeeded */
    }
    toast(`Wrote ${data.path}${copied ? " · copied to clipboard" : " (clipboard blocked)"}`, {
      label: "Clear now",
      fn: () => void runClear(),
    });
  } catch {
    toast("Export failed.");
  } finally {
    exportBtn.disabled = false;
    exportBtn.classList.remove("is-busy");
  }
}

function removeAllCommentEls(): void {
  document
    .querySelectorAll(".comment-row:not(.pr-comment-row), .file-comment, .file-comment-compose")
    .forEach((el) => el.remove());
}

async function runClear(): Promise<void> {
  if (commentCount === 0) {
    return;
  }
  if (clearBtn) {
    clearBtn.disabled = true;
    clearBtn.classList.add("is-busy");
  }
  try {
    const res = await fetch(withRepoQuery("/api/comments/clear"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ branch }),
    });
    const { cleared } = (await res.json()) as { cleared: number };
    removeAllCommentEls();
    commentCount = 0;
    updateButtons();
    toast(`Cleared ${cleared} comment${cleared === 1 ? "" : "s"}`, {
      label: "Undo",
      fn: () => void undoClear(),
    });
  } catch {
    toast("Clear failed.");
  } finally {
    if (clearBtn) {
      clearBtn.disabled = false;
      clearBtn.classList.remove("is-busy");
    }
  }
}

async function undoClear(): Promise<void> {
  try {
    const res = await fetch(withRepoQuery("/api/comments/restore"), {
      method: "POST",
      headers: clientHeaders(),
    });
    const { restored } = (await res.json()) as { restored: number };
    if (!restored) {
      return;
    }
    removeAllCommentEls();
    await loadComments();
    toast(`Restored ${restored} comment${restored === 1 ? "" : "s"}`);
  } catch {
    /* ignore */
  }
}

// --- live updates -------------------------------------------------------
// Apply changes made outside this tab (Claude working the review via the
// API, or a second browser window) without a reload.
function applyRemote(msg: ServerEvent): void {
  if (msg.origin === CLIENT_ID) {
    return;
  } // our own change, already applied
  if (!eventTargetsThisTab(msg)) {
    return;
  }
  switch (msg.type) {
    case "comment.created": {
      const c = msg.comment;
      if (c.branch && branch && c.branch !== branch) {
        return;
      }
      if (c.parentId) {
        const thread = document.querySelector(
          `.comment-thread[data-root-id="${CSS.escape(c.parentId)}"]`,
        );
        if (!thread || thread.querySelector(`.comment[data-comment-id="${CSS.escape(c.id)}"]`)) {
          return;
        }
        const compose = thread.querySelector(".comment-reply-compose");
        const html = commentCardHtml(c, { isRoot: false });
        if (compose) {
          compose.insertAdjacentHTML("beforebegin", html);
        } else {
          thread.insertAdjacentHTML("beforeend", html);
        }
        return;
      }
      if (document.querySelector(`[data-root-id="${CSS.escape(c.id)}"]`)) {
        return;
      }
      renderComment(c, []);
      commentCount++;
      updateButtons();
      return;
    }
    case "comment.updated":
      applyStatus(msg.comment);
      return;
    case "comment.deleted":
      dropComment(msg.id);
      return;
    case "comments.reset":
      removeAllCommentEls();
      void loadComments();
      return;
  }
}

function connectEvents(): void {
  // ?live=0 opts out — useful when a tool (or a headless browser) needs the
  // page to finish loading rather than hold a stream open.
  if (new URLSearchParams(location.search).get("live") === "0") {
    return;
  }
  const es = new EventSource("/api/events");
  let seenOpen = false;
  es.addEventListener("message", (e) => {
    try {
      applyRemote(JSON.parse(e.data as string) as ServerEvent);
    } catch {
      /* ignore malformed frames */
    }
  });
  // EventSource reconnects on its own; on reconnect we may have missed
  // events, so resync from the server.
  es.addEventListener("open", () => {
    if (seenOpen) {
      removeAllCommentEls();
      void loadComments();
    }
    seenOpen = true;
  });
}

// --- events ------------------------------------------------------------
// Range selection state (shift-click + drag).
interface DragAnchor {
  filePath: string;
  side: CommentSide;
  line: number;
}

let dragStart: DragAnchor | null = null;
let dragging = false;
let suppressClick = false; // set after a drag so the trailing click is ignored

function sideOf(gutter: HTMLElement): CommentSide {
  return gutter.dataset.side === "old" ? "old" : "new";
}

function attachListeners(): void {
  if (exportBtn) {
    exportBtn.addEventListener("click", () => void runExport());
  }
  if (clearBtn) {
    clearBtn.addEventListener("click", () => void runClear());
  }
  if (importPrBtn) {
    importPrBtn.addEventListener("click", () => void runImportPr());
  }

  document.addEventListener("click", (e) => {
    const add = closestFrom(e.target, ".add-comment");
    if (add) {
      e.preventDefault();
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      const gutter = add.closest<HTMLElement>(".commentable");
      const filePath = gutter?.closest<HTMLElement>(".file")?.dataset.path;
      if (!gutter || !filePath) {
        return;
      }
      const side = sideOf(gutter);
      const line = Number(gutter.dataset.commentLine);
      // shift-click extends from the line of an already-open compose (same side)
      if (e.shiftKey) {
        const open = [...document.querySelectorAll<HTMLElement>(".comment-compose-row")].find(
          (r) => r.dataset.filePath === filePath && r.dataset.side === side,
        );
        const anchor = open ? Number(open.dataset.startLine) : line;
        openLineCompose(filePath, side, anchor, line);
      } else {
        openLineCompose(filePath, side, line, line);
      }
      return;
    }

    const fileAdd = closestFrom(e.target, ".add-file-comment");
    if (fileAdd) {
      e.preventDefault();
      const file = fileAdd.closest<HTMLElement>(".file");
      if (file) {
        openFileCompose(file);
      }
      return;
    }

    const cancel = closestFrom(e.target, ".comment-cancel");
    if (cancel) {
      e.preventDefault();
      cancel
        .closest(".comment-compose-row, .file-comment-compose, .comment-reply-compose")
        ?.remove();
      clearRangeHighlight();
      return;
    }

    const reply = closestFrom(e.target, ".comment-reply-btn");
    if (reply) {
      e.preventDefault();
      const thread = reply.closest(".comment-thread");
      if (!thread) {
        return;
      }
      let compose = thread.querySelector(".comment-reply-compose");
      if (!compose) {
        thread.insertAdjacentHTML(
          "beforeend",
          `<div class="comment-reply-compose">${composeInner()}</div>`,
        );
        compose = thread.querySelector(".comment-reply-compose");
      }
      compose?.querySelector<HTMLTextAreaElement>(".comment-input")?.focus();
      return;
    }

    const postPr = closestFrom(e.target, ".comment-post-pr-btn");
    if (postPr) {
      e.preventDefault();
      const card = postPr.closest<HTMLElement>(".comment");
      const id = card?.dataset.commentId;
      if (id) {
        void runPostToPr(id);
      }
      return;
    }

    const prReply = closestFrom(e.target, ".pr-comment-reply-btn");
    if (prReply) {
      e.preventDefault();
      const thread = prReply.closest<HTMLElement>(".pr-comment-thread");
      const filePath = thread?.dataset.prPath;
      const side = thread?.dataset.prSide === "old" ? "old" : "new";
      const line = Number(thread?.dataset.prLine);
      if (filePath && Number.isFinite(line)) {
        openLineCompose(filePath, side, line, line);
      }
      return;
    }

    const resolve = closestFrom(e.target, ".comment-resolve");
    if (resolve) {
      e.preventDefault();
      const card = resolve.closest<HTMLElement>(".comment");
      const id = card?.dataset.commentId;
      if (!id) {
        return;
      }
      const isResolved = resolve.textContent?.trim() === "Reopen";
      void setStatus(id, isResolved ? "open" : "resolved");
      return;
    }

    const del = closestFrom(e.target, ".comment-delete");
    if (del) {
      e.preventDefault();
      const card = del.closest<HTMLElement>(".comment");
      if (card) {
        void removeComment(card);
      }
    }
  });

  // Drag across the gutter to select a range.
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) {
      return;
    }
    const gutter = closestFrom(e.target, ".commentable");
    const filePath = gutter?.closest<HTMLElement>(".file")?.dataset.path;
    if (!gutter || !filePath) {
      return;
    }
    dragStart = { filePath, side: sideOf(gutter), line: Number(gutter.dataset.commentLine) };
    dragging = false;
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragStart) {
      return;
    }
    const row = closestFrom(e.target, "tr");
    const cell = row?.querySelector<HTMLElement>(`.commentable[data-side="${dragStart.side}"]`);
    if (!cell) {
      return;
    } // no commentable line for this side on this row
    const line = Number(cell.dataset.commentLine);
    if (line === dragStart.line && !dragging) {
      return;
    }
    dragging = true;
    e.preventDefault(); // suppress text selection while dragging
    document.body.style.userSelect = "none";
    highlightRange(
      dragStart.filePath,
      dragStart.side,
      Math.min(dragStart.line, line),
      Math.max(dragStart.line, line),
    );
  });

  document.addEventListener("mouseup", (e) => {
    if (!dragStart) {
      return;
    }
    const ds = dragStart;
    dragStart = null;
    document.body.style.userSelect = "";
    if (!dragging) {
      return;
    } // a plain click — the click handler opens a single-line compose
    dragging = false;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 300); // clear even if no click follows
    const row = closestFrom(e.target, "tr");
    const cell = row?.querySelector<HTMLElement>(`.commentable[data-side="${ds.side}"]`);
    const endLine = cell ? Number(cell.dataset.commentLine) : ds.line;
    openLineCompose(ds.filePath, ds.side, ds.line, endLine);
  });

  document.addEventListener("submit", (e) => {
    const form = closestFrom<HTMLFormElement>(e.target, ".comment-compose");
    if (!form) {
      return;
    }
    e.preventDefault();
    if (form.closest(".comment-reply-compose")) {
      void submitReply(form);
    } else {
      void submitCompose(form);
    }
  });
}

if (commentsEnabled) {
  attachListeners();
  void loadComments();
  connectEvents();
}
