import { describe, expect, test } from "bun:test";
import { threadsFromReviewComments, type RawReviewComment } from "./prComments";

function comment(
  partial: Partial<RawReviewComment> & Pick<RawReviewComment, "id">,
): RawReviewComment {
  return {
    path: "src/a.ts",
    line: 12,
    original_line: 12,
    side: "RIGHT",
    body: "please fix",
    user: { login: "reviewer" },
    html_url: "https://github.com/acme/app/pull/1#discussion_r1",
    created_at: "2026-08-01T12:00:00Z",
    ...partial,
  };
}

describe("threadsFromReviewComments", () => {
  test("groups replies under the root and maps LEFT/RIGHT to old/new", () => {
    const threads = threadsFromReviewComments(
      [
        comment({
          id: 2,
          in_reply_to_id: 1,
          body: "follow-up",
          user: { login: "author" },
          created_at: "2026-08-01T12:05:00Z",
        }),
        comment({ id: 1, side: "LEFT", line: 9, original_line: 9, body: "root" }),
      ],
      new Set(),
    );
    expect(threads).toEqual([
      {
        path: "src/a.ts",
        side: "old",
        line: 9,
        comments: [
          {
            author: "reviewer",
            body: "root",
            createdAt: "2026-08-01T12:00:00Z",
            url: "https://github.com/acme/app/pull/1#discussion_r1",
          },
          {
            author: "author",
            body: "follow-up",
            createdAt: "2026-08-01T12:05:00Z",
            url: "https://github.com/acme/app/pull/1#discussion_r1",
          },
        ],
      },
    ]);
  });

  test("drops resolved threads and comments with no current line", () => {
    const threads = threadsFromReviewComments(
      [
        comment({ id: 10, body: "resolved" }),
        comment({ id: 11, path: "gone.ts", line: null, original_line: null, body: "outdated" }),
        comment({ id: 12, line: null, original_line: 4, body: "still placeable" }),
      ],
      new Set([10]),
    );
    expect(threads).toEqual([
      {
        path: "src/a.ts",
        side: "new",
        line: 4,
        comments: [
          {
            author: "reviewer",
            body: "still placeable",
            createdAt: "2026-08-01T12:00:00Z",
            url: "https://github.com/acme/app/pull/1#discussion_r1",
          },
        ],
      },
    ]);
  });
});
