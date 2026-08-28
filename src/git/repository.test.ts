import { afterAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_DIFF_MODE, getDiff, isSafeRefName, listLocalBranches } from './repository';

const execFileAsync = promisify(execFile);
const tmpDirs: string[] = [];

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
  });
  return stdout;
}

async function initRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prequel-git-'));
  tmpDirs.push(dir);
  await execFileAsync('git', ['init', '-b', 'main', dir]);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(dir, 'shared.txt'), 'base\n');
  await git(dir, ['add', 'shared.txt']);
  await git(dir, ['commit', '-m', 'initial']);
  await git(dir, ['checkout', '-b', 'development']);
  await fs.writeFile(path.join(dir, 'feature.txt'), 'on development\n');
  await git(dir, ['add', 'feature.txt']);
  await git(dir, ['commit', '-m', 'feature on development']);
  return dir;
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('getDiff', () => {
  test('defaults to all (branch commits vs base, plus working tree)', async () => {
    expect(DEFAULT_DIFF_MODE).toBe('all');
    const repo = await initRepo();
    const unset = await getDiff(repo, { base: 'main' });
    expect(unset.mode).toBe('all');
    expect(unset.head).toBe('development');
    expect(unset.base).toBe('main');
    expect(unset.patch).toContain('feature.txt');
  });

  test('branch shows committed development-into-main changes when the tree is clean', async () => {
    const repo = await initRepo();
    const branch = await getDiff(repo, { base: 'main', mode: 'branch' });
    expect(branch.patch).toContain('feature.txt');
    expect(branch.patch).toContain('on development');

    const working = await getDiff(repo, { base: 'main', mode: 'working' });
    expect(working.patch).toBe('');
  });

  test('working is only uncommitted changes vs HEAD, not the branch vs base', async () => {
    const repo = await initRepo();
    await fs.writeFile(path.join(repo, 'dirty.txt'), 'uncommitted\n');
    await fs.appendFile(path.join(repo, 'shared.txt'), 'local edit\n');

    const working = await getDiff(repo, { base: 'main', mode: 'working' });
    expect(working.patch).toContain('dirty.txt');
    expect(working.patch).toContain('local edit');
    expect(working.patch).not.toContain('feature.txt');

    const branch = await getDiff(repo, { base: 'main', mode: 'branch' });
    expect(branch.patch).toContain('feature.txt');
    expect(branch.patch).not.toContain('dirty.txt');
    expect(branch.patch).not.toContain('local edit');

    const all = await getDiff(repo, { base: 'main', mode: 'all' });
    expect(all.patch).toContain('feature.txt');
    expect(all.patch).toContain('dirty.txt');
    expect(all.patch).toContain('local edit');
  });

  test('head option compares another local branch without checking it out', async () => {
    const repo = await initRepo();
    await git(repo, ['checkout', 'main']);
    await fs.writeFile(path.join(repo, 'main-dirty.txt'), 'only on checkout\n');

    const compared = await getDiff(repo, { base: 'main', head: 'development', mode: 'branch' });
    expect(compared.head).toBe('development');
    expect(compared.checkedOut).toBe('main');
    expect(compared.patch).toContain('feature.txt');
    expect(compared.patch).not.toContain('main-dirty.txt');

    const allOther = await getDiff(repo, { base: 'main', head: 'development', mode: 'all' });
    expect(allOther.patch).toContain('feature.txt');
    expect(allOther.patch).not.toContain('main-dirty.txt');
  });
});

describe('listLocalBranches', () => {
  test('lists local branches and fetch times from an upstream', async () => {
    const repo = await initRepo();
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'prequel-bare-'));
    tmpDirs.push(bare);
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bare]);
    await git(repo, ['remote', 'add', 'origin', bare]);
    await git(repo, ['push', '-u', 'origin', 'main']);
    await git(repo, ['push', '-u', 'origin', 'development']);

    const branches = await listLocalBranches(repo);
    const names = branches.map((b) => b.name).sort();
    expect(names).toEqual(['development', 'main']);
    const development = branches.find((b) => b.name === 'development');
    expect(development?.current).toBe(true);
    expect(development?.upstream).toBe('origin/development');
    expect(development?.fetchedAt).toBeTruthy();
    expect(Date.parse(development!.fetchedAt!)).toBeGreaterThan(Date.now() - 60_000);

    const main = branches.find((b) => b.name === 'main');
    expect(main?.current).toBe(false);
    expect(main?.upstream).toBe('origin/main');
    expect(main?.fetchedAt).toBeTruthy();
  });
});

describe('isSafeRefName', () => {
  test('accepts normal branch names and rejects injection-shaped input', () => {
    expect(isSafeRefName('main')).toBe(true);
    expect(isSafeRefName('feature/foo-bar')).toBe(true);
    expect(isSafeRefName('HEAD')).toBe(true);
    expect(isSafeRefName('-evil')).toBe(false);
    expect(isSafeRefName('foo..bar')).toBe(false);
    expect(isSafeRefName('foo bar')).toBe(false);
    expect(isSafeRefName('foo^bar')).toBe(false);
  });
});
