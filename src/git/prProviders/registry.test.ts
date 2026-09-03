import { afterEach, describe, expect, test } from "bun:test";
import type { PushRemote } from "../pushRemote";
import {
  registerPrCommentsProvider,
  resetPrCommentsProviders,
  resolvePrCommentsProvider,
  type PrCommentsProvider,
} from "./index";

afterEach(() => resetPrCommentsProviders());

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

describe("resolvePrCommentsProvider", () => {
  test("picks github.com before the Forgejo fallback", () => {
    expect(resolvePrCommentsProvider(githubRemote).id).toBe("github");
    expect(resolvePrCommentsProvider(forgeRemote).id).toBe("forgejo");
    expect(resolvePrCommentsProvider(forgeRemote, { ghHost: "ghe.example.com" }).id).toBe("github");
  });

  test("lets a fork register a provider ahead of the Forgejo catch-all", () => {
    const gitlab: PrCommentsProvider = {
      id: "gitlab",
      label: "GitLab",
      canPush: false,
      auth: { need: "token", toastLabel: "Set GitLab token…", prompt: "GitLab token:" },
      matches: (remote) => Boolean(remote && remote.host.includes("gitlab")),
      fetchComments: async () => [],
    };
    registerPrCommentsProvider(gitlab);
    expect(
      resolvePrCommentsProvider({
        ...forgeRemote,
        host: "gitlab.example",
        baseUrl: "https://gitlab.example",
        url: "https://gitlab.example/a/b.git",
      }).id,
    ).toBe("gitlab");
    expect(resolvePrCommentsProvider(forgeRemote).id).toBe("forgejo");
    expect(resolvePrCommentsProvider(githubRemote).id).toBe("github");
  });
});
