// Facade: resolve the push remote, pick a PR-comment provider, fetch or push.
// Providers live under ./prProviders — add GitLab by registering a new one.
import { HttpError } from "../errors";
import {
  resolvePrCommentsProvider,
  type PrComment,
  type PrCommentThread,
  type PushLocalCommentInput,
  type PushLocalCommentResult,
} from "./prProviders";
import { resolvePushRemote, type PushRemote } from "./pushRemote";
import { isSafeRefName } from "./repository";

export type { PrComment, PrCommentThread, PushLocalCommentInput, PushLocalCommentResult };
export type { RawReviewComment } from "./prProviders";
export { threadsFromReviewComments } from "./prProviders";
export {
  listPrCommentsProviders,
  registerPrCommentsProvider,
  resetPrCommentsProviders,
  resolvePrCommentsProvider,
} from "./prProviders";

/** @deprecated Prefer provider.id from resolvePrCommentsProvider. */
export type PrCommentProvider = string;

export interface FetchPrCommentsResult {
  threads: PrCommentThread[];
  provider: string;
  providerLabel: string;
  canPush: boolean;
  remote: PushRemote | null;
}

export interface PushPrCommentResult extends PushLocalCommentResult {
  provider: string;
  providerLabel: string;
}

/** @deprecated Use resolvePrCommentsProvider — kept for existing tests. */
export function choosePrCommentProvider(remote: PushRemote | null, ghHost?: string | null): string {
  return resolvePrCommentsProvider(remote, { ghHost }).id;
}

export async function fetchPrReviewComments(
  repoRoot: string,
  branch: string,
  options: {
    ghHost?: string | null;
    token?: string | null;
    /** @deprecated Use `token`. */
    forgeToken?: string | null;
  } = {},
): Promise<FetchPrCommentsResult> {
  if (!isSafeRefName(branch)) {
    throw new Error("unsafe branch name");
  }
  const remote = await resolvePushRemote(repoRoot, branch);
  const provider = resolvePrCommentsProvider(remote, { ghHost: options.ghHost });
  const token = options.token ?? options.forgeToken ?? null;
  const threads = await provider.fetchComments({
    repoRoot,
    branch,
    remote,
    ghHost: options.ghHost,
    token,
  });
  return {
    threads,
    provider: provider.id,
    providerLabel: provider.label,
    canPush: provider.canPush,
    remote,
  };
}

/** Post one local line comment via the resolved provider (if it supports push). */
export async function pushLocalCommentToPr(
  repoRoot: string,
  branch: string,
  input: PushLocalCommentInput,
  options: {
    ghHost?: string | null;
    token?: string | null;
    /** @deprecated Use `token`. */
    forgeToken?: string | null;
  } = {},
): Promise<PushPrCommentResult> {
  if (!isSafeRefName(branch)) {
    throw new Error("unsafe branch name");
  }
  const remote = await resolvePushRemote(repoRoot, branch);
  const provider = resolvePrCommentsProvider(remote, { ghHost: options.ghHost });
  if (!provider.canPush || !provider.pushComment) {
    throw new HttpError(
      400,
      `Posting review comments is not supported for ${provider.label} remotes`,
    );
  }
  const token = options.token ?? options.forgeToken ?? null;
  const posted = await provider.pushComment(
    {
      repoRoot,
      branch,
      remote,
      ghHost: options.ghHost,
      token,
    },
    input,
  );
  return {
    provider: provider.id,
    providerLabel: provider.label,
    ...posted,
  };
}
