// Forgejo/Gitea provider — catch-all for non-GitHub push remotes (Gitea-compatible API).
import { HttpError } from "../../errors";
import { fetchForgejoPrReviewComments, postForgejoReviewComment } from "../forgejoComments";
import type { PushRemote } from "../pushRemote";
import type {
  PrCommentsProvider,
  ProviderContext,
  ProviderHints,
  PushLocalCommentInput,
} from "./types";

const AUTH = {
  need: "token" as const,
  toastLabel: "Set Forgejo token…",
  prompt: "Forgejo / Gitea personal access token:",
};

function authExtras() {
  return {
    needs: "token" as const,
    provider: "forgejo",
    authLabel: AUTH.toastLabel,
    authPrompt: AUTH.prompt,
  };
}

function requireRemoteAndToken(ctx: ProviderContext): {
  remote: PushRemote;
  token: string;
} {
  if (!ctx.remote) {
    throw new HttpError(400, "could not resolve git push remote");
  }
  if (!ctx.token) {
    throw new HttpError(401, "Forgejo token required", authExtras());
  }
  return { remote: ctx.remote, token: ctx.token };
}

/**
 * Matches when no earlier provider claimed the remote. Registry order puts
 * this last so github.com (and a future gitlab.com) win first.
 */
function matchesForgejo(_remote: PushRemote | null, hints: ProviderHints): boolean {
  if (hints.ghHost) {
    return false;
  }
  return true;
}

export const forgejoProvider: PrCommentsProvider = {
  id: "forgejo",
  label: "Forgejo",
  canPush: true,
  auth: AUTH,
  matches: matchesForgejo,
  async fetchComments(ctx: ProviderContext) {
    const { remote, token } = requireRemoteAndToken(ctx);
    return fetchForgejoPrReviewComments(remote, ctx.branch, token);
  },
  async pushComment(ctx: ProviderContext, input: PushLocalCommentInput) {
    const { remote, token } = requireRemoteAndToken(ctx);
    return postForgejoReviewComment(remote, ctx.branch, token, input);
  },
};
