import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { renderDiff, renderFileTree } from './render/renderer.js';
import { highlightDiff, highlightLines } from './render/highlighter.js';
import { annotateWordDiffs } from './render/wordDiff.js';
import { getDiff, getBlobLines, resolveRepoRoot } from './git/gitService.js';
import { parseDiff, inferLanguage } from './git/diffParser.js';
import { sampleDiff } from './sampleDiff.js';
import {
  listComments,
  addComment,
  getComment,
  updateComment,
  deleteComment,
  clearComments,
  restoreCleared,
} from './comments/commentStore.js';
import { buildMarkdown, buildJson } from './export/claudeExport.js';
import { marked } from 'marked';

// Resolve a user-supplied filesystem path to a repo the server can serve.
// Returns the git toplevel when the path is inside a repo; otherwise keeps the
// absolute directory (sample-diff mode). Rejects missing / non-directory paths.
async function resolveRepoSwitch(input) {
  if (typeof input !== 'string') {
    const err = new Error('path required');
    err.status = 400;
    throw err;
  }
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes('\0')) {
    const err = new Error('invalid path');
    err.status = 400;
    throw err;
  }
  const abs = path.resolve(trimmed);
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    const err = new Error('path not found');
    err.status = 404;
    throw err;
  }
  if (!st.isDirectory()) {
    const err = new Error('path is not a directory');
    err.status = 400;
    throw err;
  }
  const root = await resolveRepoRoot(abs);
  return { repoRoot: root, displayPath: root || abs };
}

marked.setOptions({ breaks: true });

// Add rendered markdown (bodyHtml) for the client to display.
function withHtml(c) {
  return { ...c, bodyHtml: marked.parse(c.body || '') };
}

// Best-effort: add ".prequel/" to the repo's local git exclude so exported
// review files don't appear as untracked in the diff or get committed. Uses
// .git/info/exclude so the user's tracked .gitignore is left untouched.
async function ensureExcluded(repoRoot) {
  try {
    const p = path.join(repoRoot, '.git', 'info', 'exclude');
    let cur = '';
    try {
      cur = await fs.readFile(p, 'utf8');
    } catch {
      /* file may not exist yet */
    }
    if (cur.split('\n').some((l) => l.trim() === '.prequel/')) return;
    const prefix = cur && !cur.endsWith('\n') ? cur + '\n' : cur;
    await fs.writeFile(p, prefix + '.prequel/\n');
  } catch {
    /* .git may be a file (worktree/submodule) or unwritable — ignore */
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const DIFF_MODES = ['all', 'branch', 'working'];

export function createServer({ repoRoot: defaultRepoRoot = null, defaultBase = null } = {}) {
  const app = express();
  // CLI-started default when a request omits ?repo= / body.repo / x-prequel-repo.
  // Each browser tab targets its own path via the URL so multiple projects can
  // be open at once. Only reachable on 127.0.0.1, but still unauthenticated.
  const defaultDisplayPath = defaultRepoRoot || process.cwd();

  app.set('view engine', 'ejs');
  app.set('views', path.join(projectRoot, 'views'));

  app.use(express.json({ limit: '1mb' }));
  app.use('/static', express.static(path.join(projectRoot, 'public')));
  app.use(
    '/vendor/primer',
    express.static(path.join(projectRoot, 'node_modules/@primer/primitives/dist/css'))
  );

  // Pick the repo for this request. Query wins, then JSON body, then header.
  async function scopeFromRequest(req) {
    const raw =
      (typeof req.query.repo === 'string' && req.query.repo.trim()) ||
      (typeof req.body?.repo === 'string' && req.body.repo.trim()) ||
      (req.get('x-prequel-repo') || '').trim() ||
      null;
    if (!raw) {
      return { repoRoot: defaultRepoRoot, displayPath: defaultDisplayPath };
    }
    return resolveRepoSwitch(raw);
  }

  app.get('/', async (req, res) => {
    // ?view=split|unified (layout); ?mode=light|dark (color); default auto.
    const view = req.query.view === 'unified' ? 'unified' : 'split';
    const colorMode = ['light', 'dark'].includes(req.query.mode) ? req.query.mode : 'auto';
    // ?diff=all|branch|working (which changes to show); ?base=<ref>.
    const diffMode = DIFF_MODES.includes(req.query.diff) ? req.query.diff : 'working';
    const requestedBase =
      (typeof req.query.base === 'string' && req.query.base ? req.query.base : null) || defaultBase;

    let repoRoot = defaultRepoRoot;
    let displayPath = defaultDisplayPath;
    let pathError = null;
    try {
      const scope = await scopeFromRequest(req);
      repoRoot = scope.repoRoot;
      displayPath = scope.displayPath;
    } catch (err) {
      pathError = err.message;
      repoRoot = null;
      displayPath =
        typeof req.query.repo === 'string' && req.query.repo.trim()
          ? req.query.repo.trim()
          : defaultDisplayPath;
    }

    let diff;
    let head;
    let base;
    let error = pathError;

    if (repoRoot) {
      try {
        const result = await getDiff(repoRoot, { base: requestedBase, mode: diffMode });
        diff = parseDiff(result.patch);
        head = result.head;
        base = result.base;
        error = null;
      } catch (err) {
        error = err.message;
      }
    }

    if (!diff) {
      // No repo (or git failed): fall back to the built-in sample so the UI
      // still demonstrates. `error` surfaces any git / path failure.
      diff = sampleDiff;
      head = sampleDiff.head;
      base = sampleDiff.base;
    }

    annotateWordDiffs(diff); // intra-line changed ranges (before highlighting)
    await highlightDiff(diff); // attaches per-line highlighted HTML in place
    // Which revision the "new" side comes from, for context expansion:
    // branch mode diffs against HEAD; all/working show the working tree.
    const rev = repoRoot && diffMode === 'branch' ? 'HEAD' : 'WORKTREE';
    const { filesHtml, summary } = renderDiff(diff, { view, rev });
    const treeHtml = diff.files.length ? renderFileTree(diff) : '';
    res.render('review', {
      repoPath: displayPath,
      repoName: path.basename(displayPath) || displayPath,
      isRepo: Boolean(repoRoot),
      base,
      head,
      diffMode,
      colorMode,
      view,
      error,
      filesHtml,
      treeHtml,
      summary,
      commentsEnabled: Boolean(repoRoot),
    });
  });

  // Validate a path the UI wants to open (does not change any global state —
  // the tab then navigates with ?repo= so each tab stays independent).
  app.post('/api/repo', async (req, res) => {
    try {
      const next = await resolveRepoSwitch(req.body?.path);
      res.json({ ok: true, repoRoot: next.repoRoot, displayPath: next.displayPath, isRepo: Boolean(next.repoRoot) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // On-demand context lines for hunk expansion.
  // ?path=&rev=HEAD|WORKTREE&start=&end= (new-side line numbers, 1-based).
  app.get('/api/context', async (req, res) => {
    let scope;
    try {
      scope = await scopeFromRequest(req);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    if (!scope.repoRoot) return res.status(400).json({ error: 'no repo' });
    const filePath = String(req.query.path || '');
    const rev = req.query.rev === 'HEAD' ? 'HEAD' : 'WORKTREE';
    const start = parseInt(req.query.start, 10);
    const end = parseInt(req.query.end, 10);
    if (!filePath || !Number.isFinite(start) || !Number.isFinite(end)) {
      return res.status(400).json({ error: 'bad params' });
    }
    try {
      const { lines, from, eof } = await getBlobLines(scope.repoRoot, {
        rev,
        path: filePath,
        start,
        end,
      });
      const html = await highlightLines(lines, inferLanguage(filePath));
      res.json({ from, eof, lines, html });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- live updates (SSE) -------------------------------------------------
  // Every mutation is broadcast so open pages reflect changes made elsewhere —
  // notably by Claude working the review through the API. Clients filter by
  // displayPath / repoRoot so tabs watching different projects stay isolated.
  const sseClients = new Set();

  // `origin` is the client id sent by whoever made the change; that client
  // already applied it locally and skips its own echo.
  function emit(type, data, req, scope) {
    const payload = JSON.stringify({
      type,
      origin: req?.get('x-prequel-client') || null,
      repoRoot: scope?.repoRoot ?? null,
      displayPath: scope?.displayPath ?? null,
      ...data,
    });
    for (const client of sseClients) {
      try {
        client.write(`data: ${payload}\n\n`);
      } catch {
        /* dropped connection; the close handler will evict it */
      }
    }
  }

  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    sseClients.add(res);
    // Comment-only frames keep the connection from idling out.
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  });

  // --- review comments ---------------------------------------------------
  app.get('/api/comments', async (req, res) => {
    let scope;
    try {
      scope = await scopeFromRequest(req);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    if (!scope.repoRoot) return res.json({ comments: [] });
    const branch = req.query.branch ? String(req.query.branch) : null;
    // Optional filters; omit them all to get everything (what the UI wants).
    //   ?status=open|resolved   ?author=user|claude   ?roots=1 (exclude replies)
    const status = ['open', 'resolved'].includes(req.query.status) ? req.query.status : null;
    const author = ['user', 'claude'].includes(req.query.author) ? req.query.author : null;
    const rootsOnly = req.query.roots === '1';
    let comments = await listComments(scope.repoRoot, branch);
    // Comments predating these fields are treated as open, user-authored roots.
    if (status) comments = comments.filter((c) => (c.status || 'open') === status);
    if (author) comments = comments.filter((c) => (c.author || 'user') === author);
    if (rootsOnly) comments = comments.filter((c) => !c.parentId);
    res.json({ comments: comments.map(withHtml) });
  });

  app.post('/api/comments', async (req, res) => {
    let scope;
    try {
      scope = await scopeFromRequest(req);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    if (!scope.repoRoot) return res.status(400).json({ error: 'no repo' });
    const repoRoot = scope.repoRoot;
    const b = req.body || {};
    const author = b.author === 'claude' ? 'claude' : 'user';

    // A reply carries only { parentId, body } — it inherits its anchor from the
    // comment it answers, so the two can never drift apart.
    if (b.parentId) {
      const parent = await getComment(repoRoot, String(b.parentId));
      if (!parent) return res.status(404).json({ error: 'parent not found' });
      if (parent.parentId) return res.status(400).json({ error: 'cannot reply to a reply' });
      if (!b.body) return res.status(400).json({ error: 'bad params' });
      const reply = await addComment(repoRoot, {
        parentId: parent.id,
        author,
        filePath: parent.filePath,
        side: parent.side,
        startLine: parent.startLine,
        endLine: parent.endLine,
        body: String(b.body),
        branch: parent.branch ?? null,
        lineSnapshot: [],
      });
      emit('comment.created', { comment: withHtml(reply) }, req, scope);
      return res.json({ comment: withHtml(reply) });
    }

    const side = b.side === 'old' ? 'old' : b.side === 'file' ? 'file' : 'new';
    // file-level comments aren't tied to a line
    const startLine = side === 'file' ? 0 : Number(b.startLine);
    if (!b.filePath || !b.body || (side !== 'file' && !Number.isFinite(startLine))) {
      return res.status(400).json({ error: 'bad params' });
    }
    const comment = await addComment(repoRoot, {
      filePath: String(b.filePath),
      side,
      startLine,
      endLine: side === 'file' ? 0 : Number.isFinite(Number(b.endLine)) ? Number(b.endLine) : startLine,
      body: String(b.body),
      branch: b.branch ? String(b.branch) : null,
      lineSnapshot: Array.isArray(b.lineSnapshot) ? b.lineSnapshot.map(String) : [],
      author,
      parentId: null,
    });
    emit('comment.created', { comment: withHtml(comment) }, req, scope);
    res.json({ comment: withHtml(comment) });
  });

  app.patch('/api/comments/:id', async (req, res) => {
    let scope;
    try {
      scope = await scopeFromRequest(req);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    if (!scope.repoRoot) return res.status(400).json({ error: 'no repo' });
    const b = req.body || {};
    const patch = {};
    if (typeof b.body === 'string') patch.body = b.body;
    if (b.status === 'open' || b.status === 'resolved') patch.status = b.status;
    const comment = await updateComment(scope.repoRoot, req.params.id, patch);
    if (!comment) return res.status(404).json({ error: 'not found' });
    emit('comment.updated', { comment: withHtml(comment) }, req, scope);
    res.json({ comment: withHtml(comment) });
  });

  app.delete('/api/comments/:id', async (req, res) => {
    let scope;
    try {
      scope = await scopeFromRequest(req);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    if (!scope.repoRoot) return res.status(400).json({ error: 'no repo' });
    const removed = await deleteComment(scope.repoRoot, req.params.id);
    if (removed) emit('comment.deleted', { id: req.params.id }, req, scope);
    res.json({ ok: Boolean(removed), removed });
  });

  // Bulk clear (with undo) for a clean slate between review rounds.
  app.post('/api/comments/clear', async (req, res) => {
    let scope;
    try {
      scope = await scopeFromRequest(req);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    if (!scope.repoRoot) return res.status(400).json({ error: 'no repo' });
    const branch = req.body?.branch ? String(req.body.branch) : null;
    const cleared = await clearComments(scope.repoRoot, branch);
    emit('comments.reset', {}, req, scope);
    res.json({ cleared });
  });

  app.post('/api/comments/restore', async (req, res) => {
    let scope;
    try {
      scope = await scopeFromRequest(req);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    if (!scope.repoRoot) return res.status(400).json({ error: 'no repo' });
    const restored = await restoreCleared(scope.repoRoot);
    emit('comments.reset', {}, req, scope);
    res.json({ restored });
  });

  // Build the Claude payload, write it to <repo>/.prequel/, and return it so the
  // client can also copy it to the clipboard.
  app.post('/api/export', async (req, res) => {
    let scope;
    try {
      scope = await scopeFromRequest(req);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    if (!scope.repoRoot) return res.status(400).json({ error: 'no repo' });
    const repoRoot = scope.repoRoot;
    const branch = req.body?.branch ? String(req.body.branch) : null;
    const format = req.body?.format === 'json' ? 'json' : 'md';
    // Replies (and anything Claude wrote) are conversation, not asks — the
    // export is the list of things being requested.
    const all = await listComments(repoRoot, branch);
    const comments = all.filter((c) => !c.parentId && (c.author || 'user') === 'user');
    if (!comments.length) return res.json({ count: 0, content: '', path: null });

    const content =
      format === 'json' ? buildJson(comments) : buildMarkdown(repoRoot, branch, comments);
    // filesystem-safe timestamp: 2026-07-17-16-40-00
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const dir = path.join(repoRoot, '.prequel');
    const filename = `review-${ts}.${format}`;
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, filename), content);
      await ensureExcluded(repoRoot); // keep .prequel/ out of the diff & commits
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ count: comments.length, content, path: path.join('.prequel', filename) });
  });

  // Identifies this server. Pass ?repo=<path> to confirm it can serve that path
  // (needed when one process backs multiple browser tabs / projects).
  app.get('/healthz', async (req, res) => {
    if (typeof req.query.repo === 'string' && req.query.repo.trim()) {
      try {
        const scope = await resolveRepoSwitch(req.query.repo);
        return res.json({
          ok: true,
          app: 'prequel',
          repoRoot: scope.repoRoot,
          displayPath: scope.displayPath,
        });
      } catch (err) {
        return res.status(err.status || 500).json({ ok: false, app: 'prequel', error: err.message });
      }
    }
    res.json({
      ok: true,
      app: 'prequel',
      repoRoot: defaultRepoRoot,
      displayPath: defaultDisplayPath,
    });
  });

  return app;
}
