#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import open from 'open';
import { startServer } from '../src/server';
import { resolveRepoRoot } from '../src/git/repository';
import { install, staleTargets, TARGET_NAMES, type InstallResult } from '../src/installer';

const VERSION = (
  JSON.parse(
    readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
      'utf8'
    )
  ) as { version: string }
).version;

interface Options {
  repoPath: string;
  base: string | null;
  port: number | null;
  open: boolean;
  project?: boolean;
  force?: boolean;
  help?: boolean;
  version?: boolean;
}

// --- tiny arg parser (avoid a dependency) --------------------------------
function parseArgs(argv: string[]): Options {
  const opts: Options = { repoPath: process.cwd(), base: null, port: null, open: true };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--base') opts.base = argv[++i] ?? null;
    else if (a === '--port') opts.port = parseListenPort(argv[++i]);
    else if (a === '--no-open') opts.open = false;
    else if (a === '--project') opts.project = true;
    else if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version' || a === '-v' || a === '-V') opts.version = true;
    else if (!a.startsWith('-')) positional.push(a);
  }
  if (positional[0]) opts.repoPath = positional[0];
  return opts;
}

const HELP = `prequel-ts — local GitHub-style PR diff reviewer

Usage:
  prequel-ts [repoPath] [--base <ref>] [--port <n>] [--no-open]
  prequel-ts install <agent> [--project] [--force]

  repoPath   Path to the git repo (default: current directory)
  --base     Base ref to diff against (default: main/master)
  --port     Port to listen on (default: first free from 4711)
  --no-open  Don't auto-open the browser
  --version  Print the installed version and exit

install sets up a coding agent to work a review directly — reading your
comments, fixing them one at a time, and resolving each in the UI as it goes.

  <agent>    claude — installs a skill; then run /prequel in Claude Code
  --project  Install into the current repo instead of your home directory, so
             it can be committed and shared with a team
  --force    Overwrite an installed file you have edited
`;

const FIRST_PORT = 4711;
const PORT_TRIES = 100;
const MIN_PORT = 1;
const MAX_PORT = 65535;

function parseListenPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    throw new Error(`--port requires an integer between ${MIN_PORT} and ${MAX_PORT}`);
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`invalid --port: ${raw}`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`invalid --port: ${raw}`);
  }
  return port;
}

function isAddressInUse(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'EADDRINUSE' || /address already in use|EADDRINUSE/i.test(String(err));
}

// Bind the first free port at or above `start`. Binding directly (rather than
// probing first) avoids a race with anything else grabbing the port.
type HttpServer = ReturnType<typeof startServer>;

function listenFromPort(start: number, listen: (port: number) => HttpServer): HttpServer {
  let lastErr: unknown = null;
  for (let port = start; port < start + PORT_TRIES; port++) {
    try {
      return listen(port);
    } catch (err) {
      if (!isAddressInUse(err)) throw err;
      lastErr = err;
    }
  }
  throw new Error(
    `no free port in ${start}–${start + PORT_TRIES - 1}` +
      (lastErr ? ` (last error: ${(lastErr as Error).message})` : '')
  );
}

async function runInstall(target: string | undefined, opts: Options): Promise<void> {
  if (!target || !TARGET_NAMES.includes(target)) {
    process.stderr.write(
      `\n  ${target ? `Unknown agent: ${target}` : 'Specify an agent'} — supported: ${TARGET_NAMES.join(', ')}\n` +
        `  e.g. prequel-ts install ${TARGET_NAMES[0]}\n\n`
    );
    process.exitCode = 1;
    return;
  }
  let result: InstallResult;
  try {
    result = await install(target, { project: opts.project, force: opts.force });
  } catch (err) {
    process.stderr.write(`\n  ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exitCode = 1;
    return;
  }
  const { status, dest } = result;
  if (status === 'conflict') {
    process.stderr.write(
      `\n  A different version is already installed at\n    ${dest}\n` +
        '  Re-run with --force to overwrite it.\n\n'
    );
    process.exitCode = 1;
    return;
  }
  const verb =
    status === 'installed'
      ? 'Installed'
      : status === 'updated'
        ? 'Updated'
        : status === 'current'
          ? 'Already current'
          : status;
  process.stdout.write(`\n  ${verb}: ${dest}\n  Run /prequel in a Claude Code session to use it.\n\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (argv[0] === 'install') return runInstall(argv[1], opts);

  const repoRoot = await resolveRepoRoot(opts.repoPath);
  // A non-repo is tolerated: the server falls back to the built-in sample diff.
  const effectiveRepo = repoRoot || opts.repoPath;

  const serve = (port: number) => startServer({ port, repoRoot, defaultBase: opts.base });
  const server = opts.port !== null ? serve(opts.port) : listenFromPort(FIRST_PORT, serve);

  const url = `http://127.0.0.1:${server.port}`;
  process.stdout.write(`\n  prequel running at ${url}\n`);
  process.stdout.write(
    `  repo: ${effectiveRepo}${repoRoot ? '' : '  (not a git repo — showing sample diff)'}\n`
  );
  process.stdout.write('  Ctrl-C to stop\n');
  for (const target of await staleTargets()) {
    process.stdout.write(
      `  (your installed ${target} integration is out of date — run: prequel-ts install ${target} --force)\n`
    );
  }
  process.stdout.write('\n');
  if (opts.open) {
    try {
      await open(url);
    } catch {
      /* headless / no browser — ignore */
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`prequel failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
