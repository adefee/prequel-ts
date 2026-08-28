import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { install } from './installer';

const tmpDirs: string[] = [];

async function tmpCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prequel-install-'));
  tmpDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('install', () => {
  test('installs to a normal path', async () => {
    const cwd = await tmpCwd();
    const result = await install('claude', { project: true, cwd });
    expect(result.status).toBe('installed');
    expect(result.dest).toBe(path.join(cwd, '.claude', 'skills', 'prequel', 'SKILL.md'));
    const written = await fs.readFile(result.dest!, 'utf8');
    expect(written.includes('Working a prequel review')).toBe(true);
    const st = await fs.lstat(result.dest!);
    expect(st.isSymbolicLink()).toBe(false);
  });

  test('refuses to write through a symbolic-link destination', async () => {
    const cwd = await tmpCwd();
    const dir = path.join(cwd, '.claude', 'skills', 'prequel');
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, 'SKILL.md');
    const outside = path.join(cwd, 'outside.md');
    await fs.writeFile(outside, 'do not clobber');
    await fs.symlink(outside, dest);

    await expect(install('claude', { project: true, force: true, cwd })).rejects.toThrow(
      /symbolic link/
    );

    expect(await fs.readFile(outside, 'utf8')).toBe('do not clobber');
  });
});
