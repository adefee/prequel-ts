# prequel-ts

*Review it before it's a pull request.*

A TypeScript fork of [mdesjardins/prequel](https://github.com/mdesjardins/prequel). Same idea: a local web app that renders a Git repo's diff in a UI that looks like GitHub's Pull Request **Files changed** tab, with comments you can hand to Claude. This fork adds multi-project tabs, branch picking, and tighter git/security behavior.

<img width="1285" alt="prequel-ts Files changed review" src="public/prequel-ts-screenshot.png" />

<img width="1285" alt="prequel-ts branch picker" src="public/prequel-ts-branch-choice-screenshot.png" />

## What's different in this fork

**TypeScript.** The CLI, server, git layer, renderer, and browser modules are TypeScript. Bun still runs the server directly (no transpile step). The page chrome is still EJS under `views/` — those templates were not rewritten.

**pnpm 11+.** Dependencies are installed with pnpm 11 (not Bun as the package manager). Settings live in `pnpm-workspace.yaml`: minimum release age, store integrity checks, and no unapproved lifecycle/build scripts.

**Change target path in UI, server supports multiple instances/tabs on different paths**  Click the header path to open a different repo in *this* tab. The caret next to it saves and lists bookmarked paths (localStorage). One running server backs many browser tabs: each tab carries its own `?repo=<path>`, so switching a tab does not change the others.

**File filter.** The file tree has a search box that filters the changed-file list as you type (substring match on the path). Empty folders drop out; Escape clears the query.

**Branch compare.** The header pills list local branches. You can pick any local branch as the head or the base (`?head=` / `?base=`) without checking anything out. All / Branch / Working are consistent with that choice: the working-tree overlay only applies when the selected head *is* the checkout; comparing another branch stays a committed-ref diff. When the head is not checked out, the header says so.

**Fetch freshness.** Each branch option shows when its upstream was last fetched (`fetched 12m ago`, `no remote`, …). Hover for the exact time and the tracking ref.

**Hardening.** Comment markdown is allowlist-sanitized before it is interpolated as HTML. User-supplied git refs are rejected unless they are a real, safe commit name. Mutations require same-origin. Request bodies are size-capped. Static files cannot escape their roots. Paths with NULs are refused. The server binds loopback-only. The Claude skill installer refuses to write through a symlink.

**Loading.** The header streams first (path, branch pills, toggles) while git diff + highlight finish, with a boot panel and a progress bar on navigation.

The original still applies: split/unified views, system light/dark (or `?mode=`), line and file comments, live SSE updates when Claude works a review, and `prequel install claude`.

## Install

This fork publishes as `@adefee/prequel-ts` (not the original `@mdesjardins/prequel` npm package) and installs a `prequel-ts` command so it does not overwrite the upstream `prequel` binary. Clone this repo and run the commands below (Bun is the runtime; [pnpm](https://pnpm.io) 11+ installs dependencies and enforces the supply-chain settings in `pnpm-workspace.yaml`).

```bash
git clone https://github.com/adefee/prequel-ts.git
cd prequel-ts
pnpm install
pnpm build                # bundle the browser modules into public/dist
pnpm start                # review the current directory

# optional: put `prequel-ts` on your PATH (does not replace `prequel`)
pnpm add -g .
# to undo the shim
pnpm remove -g @adefee/prequel-ts
```

Or point it at another repo:

```bash
pnpm start -- /path/to/repo [--base <ref>] [--port <n>] [--no-open]
```

One process can back several tabs on different projects. Each tab's `?repo=` and the header path picker are independent.

## Closing the loop with Claude

> This is presently unchanged from the original behavior. I don't use this functionality today, but preserved it for others that might.

Instead of copy/pasting the export, install the bundled skill so Claude Code can
read your comments straight from the running server and resolve each one as it
addresses it:

```bash
pnpm start -- install claude
# or, once the CLI is on your PATH: prequel-ts install claude
```

It goes in `~/.claude/skills` rather than a project's `.claude/skills` because you
run prequel *against* other repos — pass `--project` to install into the current
repo instead, if you'd rather commit it and share it with a team. The command is
idempotent, and refuses to overwrite a skill you've edited unless you pass
`--force`. If an installed skill falls behind after an upgrade, prequel says so at
startup.

`claude` is the only agent supported today; the command takes an agent name so
support for others can be added without renaming it.

Then, from a Claude Code session in the repo you're reviewing: `/prequel`. Claude finds the server by scanning ports 4711-4720
and matching the repo root reported by `/healthz`, works the comments one at a
time, and `PATCH`es each to `status: resolved` as it goes.

The page updates live over an event stream, so comments resolve and Claude's
replies appear as it works — no reload. Append `?live=0` to the URL to opt out.

Claude can reply in a thread as well as resolve it, which is where it explains a
decision or says why it *didn't* make a change. Its messages are labelled and
accented so they're distinguishable from yours, and they never re-enter its own
work queue. You can also resolve or reopen any comment yourself from the thread.

## Development

```bash
pnpm dev                          # review the current directory (Vite HMR + bun --watch)
pnpm dev -- ~/code/other-project  # review somewhere else
pnpm typecheck                    # tsc --noEmit, browser + server configs
```

`pnpm dev` listens on a fixed port (4711 by default, `PREQUEL_PORT` to change it)
so the browser URL and Vite's socket survive restarts. `pnpm build` is required
before `pnpm start`: outside dev, the page loads the bundled modules from
`public/dist/`.

URL params (all optional): `?view=split|unified` picks the layout,
`?diff=all|branch|working` picks which changes to show (default `all` — the
branch vs its base, plus uncommitted work when the head is the checkout;
persists), `?repo=<path>` picks the project for that tab, `?head=<ref>` /
`?base=<ref>` pick the compared branches (does not check anything out),
`?mode=light|dark` forces a color mode (default follows the OS).

## Layout

```
bin/prequel.ts             CLI entry (port selection, browser launch, repo resolution)
src/server.ts              Bun.serve routes: page, /api/*, SSE, static files
src/types.ts               shared domain types (diff model, comments, repo scope)
src/errors.ts              errors that carry an HTTP status
src/git/gitService.ts      git CLI wrapper: refs, diff generation, blob lines
src/git/gitService.test.ts compare modes, other-branch head, fetch stamps, ref safety
src/git/diffParser.ts      raw patch text -> diff model
src/render/renderer.ts     diff model -> GitHub-faithful HTML (unified + split)
src/render/highlighter.ts  Shiki dual-theme syntax highlighting + word-diff overlay
src/render/wordDiff.ts     intra-line (word-level) diff ranges
src/comments/commentStore.ts   per-repo comment persistence (~/.prequel)
src/comments/commentHtml.ts    markdown -> allowlist-sanitized HTML
src/export/claudeExport.ts     build markdown/JSON export payload
src/sampleDiff.ts          built-in sample diff (fallback outside a repo)
src/installer.ts           `prequel-ts install <agent>`
views/review-start.ejs     streamed page chrome (header, loaders)
views/review-end.ejs       streamed diff body + client modules
views/ref-picker.ejs       local-branch compare dropdown + last-fetch label
public/css/diff.css        GitHub "Files changed" clone
public/dist/               Vite output, served at /static/dist (generated)
client/review.ts           toggles, collapse/expand, Viewed, hunk expansion, project picker
client/comments.ts         hover-+, compose, inject threads, delete, live updates
client/dom.ts              shared DOM/URL helpers
scripts/dev.ts             runs Vite + `bun --watch` together
pnpm-workspace.yaml        pnpm 11+ supply-chain settings
```
