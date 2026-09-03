import { describe, expect, test } from "bun:test";
import { threadsFromForgejoComments } from "./forgejoComments";
import { choosePrCommentProvider } from "./prComments";
import type { PushRemote } from "./pushRemote";

describe("threadsFromForgejoComments", () => {
  test("groups by path+side+line and prefers new_position", () => {
    const threads = threadsFromForgejoComments([
      {
        id: 1,
        path: "src/a.ts",
        body: "root",
        user: { login: "reviewer" },
        html_url: "https://forge/x",
        created_at: "2026-08-01T12:00:00Z",
        new_position: 12,
        old_position: 0,
      },
      {
        id: 2,
        path: "src/a.ts",
        body: "follow-up",
        user: { username: "author" },
        html_url: "https://forge/y",
        created_at: "2026-08-01T12:05:00Z",
        new_position: 12,
      },
      {
        id: 3,
        path: "src/b.ts",
        body: "left side",
        user: { login: "reviewer" },
        created_at: "2026-08-01T12:01:00Z",
        old_position: 4,
        new_position: 0,
      },
      {
        id: 4,
        path: "gone.ts",
        body: "no line",
        created_at: "2026-08-01T12:00:00Z",
      },
    ]);
    expect(threads).toEqual([
      {
        path: "src/a.ts",
        side: "new",
        line: 12,
        comments: [
          {
            author: "reviewer",
            body: "root",
            createdAt: "2026-08-01T12:00:00Z",
            url: "https://forge/x",
          },
          {
            author: "author",
            body: "follow-up",
            createdAt: "2026-08-01T12:05:00Z",
            url: "https://forge/y",
          },
        ],
      },
      {
        path: "src/b.ts",
        side: "old",
        line: 4,
        comments: [
          {
            author: "reviewer",
            body: "left side",
            createdAt: "2026-08-01T12:01:00Z",
            url: "",
          },
        ],
      },
    ]);
  });

  test("falls back to legacy position fields", () => {
    const threads = threadsFromForgejoComments([
      {
        id: 9,
        path: "legacy.ts",
        body: "old shape",
        user: { login: "r" },
        created_at: "2026-08-01T12:00:00Z",
        position: 3,
        original_position: 1,
      },
    ]);
    expect(threads).toEqual([
      {
        path: "legacy.ts",
        side: "new",
        line: 3,
        comments: [
          {
            author: "r",
            body: "old shape",
            createdAt: "2026-08-01T12:00:00Z",
            url: "",
          },
        ],
      },
    ]);
  });
});

describe("choosePrCommentProvider", () => {
  const forgeRemote: PushRemote = {
    remoteName: "origin",
    url: "https://code.example/a/b.git",
    baseUrl: "https://code.example",
    host: "code.example",
    owner: "a",
    repo: "b",
  };
  const githubRemote: PushRemote = {
    ...forgeRemote,
    url: "https://github.com/a/b.git",
    baseUrl: "https://github.com",
    host: "github.com",
  };

  test("uses github for github.com or an explicit ghHost", () => {
    expect(choosePrCommentProvider(githubRemote, null)).toBe("github");
    expect(choosePrCommentProvider(forgeRemote, "ghe.example.com")).toBe("github");
    expect(choosePrCommentProvider(forgeRemote, null)).toBe("forgejo");
    expect(choosePrCommentProvider(null, null)).toBe("forgejo");
  });
});
