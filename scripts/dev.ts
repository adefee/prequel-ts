#!/usr/bin/env bun
// Dev runner: Vite (client HMR) alongside `bun --watch` (server restart on
// change). Kept as a Bun script so dev needs no extra dependency.
//
// The port is fixed here — unlike `prequel` proper, which scans for a free one
// — so the browser URL and Vite's HMR socket stay stable across restarts.
// Anything after `pnpm dev --` is forwarded to the CLI.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';

/** Just enough of Bun's Subprocess to supervise it, without its stdio generics. */
interface Child {
  kill(): void;
  readonly exited: Promise<number>;
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(projectRoot, 'node_modules', '.bin', 'vite');

const VITE_PORT = Number(process.env.PREQUEL_VITE_PORT ?? 5173);
const APP_PORT = Number(process.env.PREQUEL_PORT ?? 4711);
const viteOrigin = `http://127.0.0.1:${VITE_PORT}`;
const appUrl = `http://127.0.0.1:${APP_PORT}`;

if (!existsSync(viteBin)) {
  process.stderr.write('\n  vite is not installed — run `pnpm install` first.\n\n');
  process.exit(1);
}

const children: Child[] = [];
let shuttingDown = false;

function shutdown(code = 0): never {
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(code);
}

function spawn(cmd: string[], env: Record<string, string> = {}): void {
  const child: Child = Bun.spawn(cmd, {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  children.push(child);
  // If either half dies, the other is useless — take the whole thing down.
  void child.exited.then((code) => {
    if (!shuttingDown) shutdown(code);
  });
}

// Wait for the server to answer before opening a browser, so the first load
// isn't a connection error.
async function waitForApp(timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), remaining);
    try {
      const res = await fetch(`${appUrl}/healthz`, { signal: ac.signal });
      if (res.ok) return true;
    } catch {
      /* not listening yet */
    } finally {
      clearTimeout(timer);
    }
    await Bun.sleep(200);
  }
  return false;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => shutdown(0));
}

spawn([viteBin, '--port', String(VITE_PORT), '--strictPort']);
spawn(
  [
    process.execPath,
    '--watch',
    'bin/prequel.ts',
    '--port',
    String(APP_PORT),
    '--no-open',
    ...process.argv.slice(2),
  ],
  { PREQUEL_DEV: '1', PREQUEL_VITE_ORIGIN: viteOrigin }
);

process.stdout.write(`\n  app:  ${appUrl}\n  vite: ${viteOrigin}  (client HMR)\n\n`);

if (await waitForApp()) {
  await open(appUrl).catch(() => {
    /* headless / no browser — the URL is printed above */
  });
}
