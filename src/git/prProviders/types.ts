// Shared types for PR review-comment providers (GitHub, Forgejo, …).
// A fork adds a new forge by implementing PrCommentsProvider and registering it.
import type { CommentSide } from "../../comments/commentStore";
import type { PushRemote } from "../pushRemote";

export interface PrComment {
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface PrCommentThread {
  path: string;
  side: CommentSide;
  line: number;
  comments: PrComment[];
}

export interface PushLocalCommentInput {
  path: string;
  side: "old" | "new";
  line: number;
  body: string;
}

export interface PushLocalCommentResult {
  pullNumber: number;
  htmlUrl: string;
}

/** Hints that influence provider selection (e.g. an explicit GHE hostname). */
export interface ProviderHints {
  ghHost?: string | null;
}

export interface ProviderContext {
  repoRoot: string;
  branch: string;
  remote: PushRemote | null;
  /** GitHub Enterprise hostname for `gh` / GH_HOST. */
  ghHost?: string | null;
  /** PAT for HTTP API providers (Forgejo, GitLab, …). */
  token?: string | null;
}

export type ProviderAuthNeed = "token" | "ghHost";

export interface PrCommentsProvider {
  /** Stable id used in config (`tokens.<id>`) and API responses. */
  readonly id: string;
  /** Short UI label, e.g. "Forgejo" → badge "Forgejo review comment". */
  readonly label: string;
  /** Whether this provider can post local line comments upstream. */
  readonly canPush: boolean;
  /** Prompt copy when the UI asks for a token / host. */
  readonly auth: {
    need: ProviderAuthNeed;
    toastLabel: string;
    prompt: string;
  };
  /**
   * True if this provider should handle the given push remote.
   * Checked in registry order; first match wins. Put specific hosts
   * (github.com, gitlab.com) before a catch-all like Forgejo.
   */
  matches(remote: PushRemote | null, hints: ProviderHints): boolean;
  fetchComments(ctx: ProviderContext): Promise<PrCommentThread[]>;
  pushComment?(ctx: ProviderContext, input: PushLocalCommentInput): Promise<PushLocalCommentResult>;
}
