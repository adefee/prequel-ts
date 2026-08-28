# prequel-ts

_Review it before it's a pull request._

A TypeScript fork of [mdesjardins/prequel](https://github.com/mdesjardins/prequel). Same idea: a local web app that renders a Git repo's diff in a UI that looks like GitHub's Pull Request **Files changed** tab, with comments you can hand to Claude. This fork adds multi-project tabs, branch picking, GitHub PR comment import, and tighter git/security behavior.

<img width="1285" alt="prequel-ts Files changed review" src="public/prequel-ts-screenshot.png" />

<img width="1285" alt="prequel-ts branch picker" src="public/prequel-ts-branch-choice-screenshot.png" />

## What's different in this fork

**TypeScript.** The CLI, server, git layer, renderer, and browser modules are TypeScript. Bun still runs the server directly (no transpile step). The page chrome is still EJS under `views/` — those templates were not rewritten.

**pnpm 11+.** Dependencies are installed with pnpm 11 (not Bun as the package manager). Settings live in `pnpm-workspace.yaml`: minimum release age, store integrity checks, and no unapproved lifecycle/build scripts.

**Change target path in UI, server supports multiple instances/tabs on different paths.** Click the header path to open a different repo in _this_ tab. The caret next to it saves and lists bookmarked paths (localStorage). One running server backs many browser tabs: each tab carries its own `?repo=<path>`, so switching a tab does not change the others.

**File filter.** The file tree has a search box that filters the changed-file list as you type (substring match on the path). Empty folders drop out; Escape clears the query.

**Branch compare.** The header pills list local branches. You can pick any local branch as the head or the base (`?head=` / `?base=`) without checking anything out. All / Branch / Working are consistent with that choice: the working-tree overlay only applies when the selected head _is_ the checkout; comparing another branch stays a committed-ref diff. When the head is not checked out, the header says so.

**Fetch freshness.** Each branch option shows when its upstream was last fetched (`fetched 12m ago`, `no remote`, …). Hover for the exact time and the tracking ref.

**GitHub PR comments.** **Import PR comments** pulls line-anchored review threads from the current head branch's open GitHub PR (via the [`gh`](https://cli.github.com) CLI) and shows them next to the matching diff line. Reply locally opens a normal prequel comment at that line — nothing is written back to GitHub. Already-resolved GitHub threads are skipped when GraphQL allows it. GitHub Enterprise hosts can be saved once per repo.

**Hardening.** Comment markdown is allowlist-sanitized before it is interpolated as HTML. User-supplied git refs are rejected unless they are a real, safe commit name. Mutations require same-origin. Request bodies are size-capped. Static files cannot escape their roots. Paths with NULs are refused. The server binds loopback-only. The Claude skill installer refuses to write through a symlink.

**Loading.** The header streams first (path, branch pills, toggles) while git diff + highlight finish, with a boot panel and a progress bar on navigation.

The original still applies: split/unified views, system light/dark (or `?mode=`), line and file comments, live SSE updates when Claude works a review, and `prequel-ts install claude`.

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

Importing GitHub PR comments also needs [`gh`](https://cli.github.com) on your `PATH` and an authenticated session (`gh auth login`). That is optional for everything else.

## Comments

Hover `+` on a line (or the file-header button) to leave a comment. Markdown is supported. Threads can be replied to, resolved, or reopened from the card. Comments are stored per repo under `~/.prequel/`, tagged with the branch they were written on.

**Export for Claude** writes open user comments to `<repo>/.prequel/` and copies the payload to the clipboard. **Clear** drops the current branch's comments (with undo) so the next review round starts clean.

**Import PR comments** fetches review comments from the open GitHub PR for the selected head branch and anchors them as read-only cards. They are not stored as prequel comments. **Reply locally** opens the normal compose box at that line. If `gh` cannot see the host (typical for GitHub Enterprise), the toast offers **Set GH host…**; that hostname is remembered in `~/.prequel/pr-config.json` for the repo.

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
run prequel _against_ other repos — pass `--project` to install into the current
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
decision or says why it _didn't_ make a change. Its messages are labelled and
accented so they're distinguishable from yours, and they never re-enter its own
work queue. You can also resolve or reopen any comment yourself from the thread.

Imported GitHub review cards are context only. Claude's queue is the local
prequel comments (including anything you wrote with **Reply locally**).

## Development

```bash
pnpm install                      # install deps (pnpm 11+, Bun runtime)
pnpm dev                          # review the current directory (Vite HMR + bun --watch)
pnpm dev -- ~/code/other-project  # review somewhere else
pnpm test                         # bun test (unit tests next to the modules)
pnpm lint                         # oxlint
pnpm format                       # rewrite with oxfmt
pnpm format:check                 # oxfmt --check (what CI runs)
pnpm typecheck                    # tsc --noEmit, browser + server configs
pnpm build                        # bundle client modules into public/dist
pnpm check                        # format:check + lint + typecheck + test + build
```

`pnpm check` is the full local gate. Pull requests (and pushes to `main`) run the
same command on GitHub Actions.

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
bin/prequel.ts                 CLI entry (port selection, browser launch, repo resolution)
src/server.ts                  Bun.serve routes: page, /api/*, SSE, static files
src/errors.ts                  errors that carry an HTTP status
src/git/repository.ts          git CLI wrapper: refs, diff generation, blob lines
src/git/diff.ts                raw patch text -> diff model
src/git/prComments.ts          read-only GitHub PR review-comment fetch (`gh`)
src/git/prConfig.ts            per-repo GitHub host (Enterprise)
src/render/renderer.ts         diff model -> GitHub-faithful HTML (unified + split)
src/render/highlighter.ts      Shiki dual-theme syntax highlighting + word-diff overlay
src/render/wordDiff.ts         intra-line (word-level) diff ranges
src/comments/commentStore.ts   per-repo comment persistence (~/.prequel)
src/comments/commentHtml.ts    markdown -> allowlist-sanitized HTML
src/export/claudeExport.ts     build markdown/JSON export payload
src/sampleDiff.ts              built-in sample diff (fallback outside a repo)
src/installer.ts               `prequel-ts install <agent>`
views/review-start.ejs         streamed page chrome (header, loaders)
views/review-end.ejs           streamed diff body + client modules
views/ref-picker.ejs           local-branch compare dropdown + last-fetch label
public/css/diff.css            GitHub "Files changed" clone
public/dist/                   Vite output, served at /static/dist (generated)
client/review.ts               toggles, collapse/expand, Viewed, hunk expansion, project picker
client/comments.ts             hover-+, compose, import PR comments, live updates
client/dom.ts                  shared DOM/URL helpers
scripts/dev.ts                 runs Vite + `bun --watch` together
.github/workflows/ci.yml       PR / main: pnpm check
pnpm-workspace.yaml            pnpm 11+ supply-chain settings
```

Tests live next to the module they cover (`*.test.ts`) and run with `pnpm test`.
