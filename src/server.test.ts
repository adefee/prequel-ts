import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './server';

const dirs: string[] = [];
afterAll(async () => Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prequel-server-'));
  const comments = await fs.mkdtemp(path.join(os.tmpdir(), 'prequel-comments-'));
  dirs.push(root, comments);
  execFileSync('git', ['-C', root, 'init', '-q']);
  return { root, app: createApp({ repoRoot: root, commentDir: comments, viteOrigin: null }) };
}

function request(app: ReturnType<typeof createApp>, pathname: string, method = 'GET', body?: object) {
  return app(new Request(`http://localhost${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }));
}

async function json(response: Response): Promise<any> {
  expect(response.status).toBe(200);
  return response.json();
}

const rootComment = {
  filePath: 'src/a.ts', side: 'old', startLine: 7, endLine: 8,
  body: '**review** <script>bad()</script>', branch: 'feature', lineSnapshot: ['const a = 1;'],
};

describe('comment API workflows', () => {
  test('persists anchored conversations through their lifecycle', async () => {
    const { root, app } = await setup();
    const created = (await json(await request(app, '/api/comments', 'POST', rootComment))).comment;
    const reply = (await json(await request(app, '/api/comments', 'POST', {
      parentId: created.id, body: 'reply only',
    }))).comment;
    expect(reply).toMatchObject({
      repoRoot: root, parentId: created.id, branch: 'feature', filePath: 'src/a.ts',
      side: 'old', startLine: 7, endLine: 8, lineSnapshot: [],
    });

    await json(await request(app, `/api/comments/${created.id}`, 'PATCH', { status: 'resolved' }));
    const listed = await json(await request(app, '/api/comments?branch=feature'));
    expect(listed.comments).toHaveLength(2);
    expect(listed.comments[0]).toMatchObject({ status: 'resolved' });
    expect(listed.comments[0].bodyHtml).toContain('<strong>review</strong>');
    expect(listed.comments[0].bodyHtml).not.toContain('<script>');

    expect((await json(await request(app, `/api/comments/${created.id}`, 'DELETE'))).removed).toBe(2);
    expect((await json(await request(app, '/api/comments?branch=feature'))).comments).toEqual([]);
  });

  test('clears one branch and restores it without disturbing another', async () => {
    const { app } = await setup();
    for (const branch of ['one', 'two']) {
      await json(await request(app, '/api/comments', 'POST', { ...rootComment, branch, body: branch }));
    }
    expect((await json(await request(app, '/api/comments/clear', 'POST', { branch: 'one' }))).cleared).toBe(1);
    expect((await json(await request(app, '/api/comments?branch=one'))).comments).toEqual([]);
    expect((await json(await request(app, '/api/comments?branch=two'))).comments).toHaveLength(1);
    expect((await json(await request(app, '/api/comments/restore', 'POST', {}))).restored).toBe(1);
    expect((await json(await request(app, '/api/comments?branch=one'))).comments).toHaveLength(1);
  });
});

test('export selects and orders only actionable user roots on the chosen branch', async () => {
  const { root, app } = await setup();
  const add = async (body: object) => (await json(await request(app, '/api/comments', 'POST', body))).comment;
  const later = await add({ ...rootComment, filePath: 'z.ts', startLine: 9, endLine: 9,
    side: 'new', body: 'use ``` safely', lineSnapshot: ['```'], branch: 'chosen' });
  const first = await add({ ...rootComment, filePath: 'a.ts', startLine: 2, endLine: 3,
    side: 'old', body: 'fix first', lineSnapshot: ['one', 'two'], branch: 'chosen' });
  await add({ parentId: first.id, body: 'conversation' });
  await add({ ...rootComment, body: 'agent', author: 'claude', branch: 'chosen' });
  const resolved = await add({ ...rootComment, body: 'done', branch: 'chosen' });
  await json(await request(app, `/api/comments/${resolved.id}`, 'PATCH', { status: 'resolved' }));
  await add({ ...rootComment, body: 'other branch', branch: 'other' });

  const markdown = await json(await request(app, '/api/export', 'POST', { branch: 'chosen' }));
  expect(markdown.count).toBe(2);
  expect(markdown.content.indexOf('## a.ts')).toBeLessThan(markdown.content.indexOf('## z.ts'));
  expect(markdown.content).toContain(`<!-- prequel:id ${first.id} -->`);
  expect(markdown.content).toContain('### L2–3 (old side)');
  expect(markdown.content).toContain('````typescript\n```\n````');
  expect(markdown.content).not.toContain('conversation');
  expect(markdown.content).not.toContain('agent');

  const exported = await json(await request(app, '/api/export', 'POST', { branch: 'chosen', format: 'json' }));
  const data = JSON.parse(exported.content);
  expect(data).toEqual([
    { id: first.id, file: 'a.ts', side: 'old', lines: [2, 3], code: 'one\ntwo', comment: 'fix first' },
    { id: later.id, file: 'z.ts', side: 'new', lines: [9, 9], code: '```', comment: 'use ``` safely' },
  ]);
  expect(exported.path).toMatch(/^\.prequel\/review-.*\.json$/);
  expect(await fs.readFile(path.join(root, exported.path), 'utf8')).toBe(exported.content);
});
