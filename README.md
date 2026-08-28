# prequel

*Review it before it's a pull request.*

A local web app that renders a Git repo's diff using a UI that looks like
GitHub's Pull Request **Files changed** tab. Supports system light/dark mode.

<img width="1285" height="718" alt="Screen Shot 2026-08-11 at 11 40 30" src="https://github.com/user-attachments/assets/67adea24-2a1b-4fb2-921c-73618fe2a273" />

## Why

If you're like me, you've probably spent hundreds of hours over more than a decade reviewing code, and you've done almost all of it through Github's pull request review interface. It's comfortable, and for me, it shifts my brain into a "mode" where it can efficiently evaluate and comment on code.

In the day of agentic coding, I was finding that my brain likes this style of review so much that I'd actually push code to Github to review it before telling Claude what changes I wanted made. That seemed silly, so I created this thing. It's basically a simulator of Github's PR interface, but local: the current branch into its base, plus any staged, unstaged, or untracked files. You can comment on them and easily dump this into your Claude Code session to make changes.

In the future I'd like to tighten the feedback loop with Claude and not copy/paste my comments for it to work on, not manually refresh the page, etc., but this was mostly a proof of concept.

## Note

This is almost entirely vibe-coded. I've barely even looked at the code. Having said that, I am a giant hypocrite and am not accepting any AI created contributions to this codebase right now. In fact, I'm not really accepting *any* changes yet. There's a lot I want to do personally before opening this up to that. 

## Install

prequel runs on [Bun](https://bun.sh) — the CLI and server are TypeScript that
Bun executes directly, so there's no build step to run the app.

```bash
bun install -g @mdesjardins/prequel
```

Then run it from inside any git repo:

```bash
prequel [repoPath] [--base <ref>] [--port <n>] [--no-open]
```

One running server can back several browser tabs on different projects: each tab
carries its own `?repo=<path>`, and the header path is editable (with a dropdown
of saved projects) to switch a tab without touching the others.

## Closing the loop with Claude

Instead of copy/pasting the export, install the bundled skill so Claude Code can
read your comments straight from the running server and resolve each one as it
addresses it:

```bash
prequel install claude
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

## Run from source

Dependencies are managed with [pnpm](https://pnpm.io) 11+, which enforces the
supply-chain settings in `pnpm-workspace.yaml` (minimum release age, store
integrity, no unapproved lifecycle scripts). Bun is the runtime, not the package
manager.

```bash
pnpm install
pnpm build                # bundle the browser modules into public/dist
pnpm start                # run the CLI against the current directory
```

For development, `pnpm dev` runs both halves: Vite serves `client/*.ts` with hot
reload, and Bun restarts the server when anything under `src/` or `bin/` changes.
It listens on a fixed port (4711 by default, `PREQUEL_PORT` to change it) so the
browser URL and Vite's socket survive restarts. Arguments are forwarded to the
CLI:

```bash
pnpm dev                          # review the current directory
pnpm dev -- ~/code/other-project  # review somewhere else
pnpm typecheck                    # tsc --noEmit, browser + server configs
```

`pnpm build` is required before `pnpm start`: outside dev, the page loads the
bundled modules from `public/dist/`.

URL params (all optional): `?view=split|unified` picks the layout,
`?diff=all|branch|working` picks which changes to show (default `all` — the
branch vs its base, plus uncommitted work; persists), `?repo=<path>` picks the
project for that tab, `?head=<ref>` / `?base=<ref>` pick the compared branches
(the header pills list local branches; this does not check anything out),
`?mode=light|dark` forces a color mode (default follows the OS).

## Layout

```
bin/prequel.ts             CLI entry (port selection, browser launch, repo resolution)
src/server.ts              Bun.serve routes: page, /api/*, SSE, static files
src/types.ts               shared domain types (diff model, comments, repo scope)
src/errors.ts              errors that carry an HTTP status
src/git/gitService.ts      git CLI wrapper: refs, diff generation, blob lines
src/git/diffParser.ts      raw patch text -> diff model
src/render/renderer.ts     diff model -> GitHub-faithful HTML (unified + split)
src/render/highlighter.ts  Shiki dual-theme syntax highlighting + word-diff overlay
src/render/wordDiff.ts     intra-line (word-level) diff ranges
src/comments/commentStore.ts   per-repo comment persistence (~/.prequel)
src/export/claudeExport.ts     build markdown/JSON export payload
src/sampleDiff.ts          built-in sample diff (fallback outside a repo)
views/review-start.ejs     streamed page chrome (header, loaders)
views/review-end.ejs       streamed diff body + client modules
views/ref-picker.ejs       local-branch compare dropdown
public/css/diff.css        GitHub "Files changed" clone
public/dist/               Vite output, served at /static/dist (generated)
client/review.ts           toggles, collapse/expand, Viewed, hunk expansion, project picker
client/comments.ts         hover-+, compose, inject threads, delete, live updates
client/dom.ts              shared DOM/URL helpers
scripts/dev.ts             runs Vite + `bun --watch` together
```
