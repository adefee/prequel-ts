// Public entry for PR comment providers.
export type {
  PrComment,
  PrCommentThread,
  PrCommentsProvider,
  ProviderAuthNeed,
  ProviderContext,
  ProviderHints,
  PushLocalCommentInput,
  PushLocalCommentResult,
} from "./types";
export {
  listPrCommentsProviders,
  registerPrCommentsProvider,
  resetPrCommentsProviders,
  resolvePrCommentsProvider,
  setPrCommentsProviders,
} from "./registry";
export { githubProvider, threadsFromReviewComments, type RawReviewComment } from "./github";
export { forgejoProvider } from "./forgejo";
