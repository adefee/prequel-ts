import { describe, expect, test } from "bun:test";
import { HttpError } from "../errors";
import { postForgejoReviewComment } from "./forgejoComments";
import type { PushRemote } from "./pushRemote";

const remote: PushRemote = {
  remoteName: "origin",
  url: "https://forge.example/acme/app.git",
  baseUrl: "https://forge.example",
  host: "forge.example",
  owner: "acme",
  repo: "app",
};

describe("postForgejoReviewComment", () => {
  test("posts a COMMENT review with new_position and fails when no PR matches", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/pulls?") && !url.includes("/reviews")) {
        return new Response(
          JSON.stringify([
            {
              number: 7,
              html_url: "https://forge.example/acme/app/pulls/7",
              head: { ref: "feature" },
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/pulls/7/reviews") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: 1,
            html_url: "https://forge.example/acme/app/pulls/7#issuecomment-1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    try {
      const posted = await postForgejoReviewComment(remote, "feature", "tok", {
        path: "src/a.ts",
        side: "new",
        line: 12,
        body: "please fix",
      });
      expect(posted).toEqual({
        pullNumber: 7,
        htmlUrl: "https://forge.example/acme/app/pulls/7#issuecomment-1",
      });
      const post = calls.find((c) => c.init?.method === "POST");
      expect(JSON.parse(String(post!.init!.body))).toEqual({
        body: "",
        event: "COMMENT",
        comments: [
          {
            path: "src/a.ts",
            body: "please fix",
            new_position: 12,
            old_position: 0,
          },
        ],
      });

      await expect(
        postForgejoReviewComment(remote, "missing", "tok", {
          path: "src/a.ts",
          side: "old",
          line: 3,
          body: "x",
        }),
      ).rejects.toBeInstanceOf(HttpError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
