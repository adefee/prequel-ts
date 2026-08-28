// Domain types shared by the git layer, the renderer, the comment store and the
// HTTP layer. The diff model mirrors what `git diff` gives us, so the renderer
// can stay a pure function of it.

/** Which side of the diff a line belongs to. */
export type LineType = 'context' | 'add' | 'del';

/** A `[start, end)` character range within a line. */
export type CharRange = [number, number];

export interface DiffLine {
  type: LineType;
  oldNumber: number | null;
  newNumber: number | null;
  content: string;
  /** Intra-line changed ranges, attached by wordDiff. */
  wordRanges?: CharRange[];
  /** Pre-rendered, already-escaped HTML, attached by the highlighter. */
  html?: string;
}

export interface Hunk {
  header: string;
  sectionHeading: string;
  oldStart: number;
  newStart: number;
  oldLines?: number;
  newLines?: number;
  lines: DiffLine[];
}

export type FileStatus = 'added' | 'modified' | 'removed' | 'renamed' | 'copied';

export interface DiffFile {
  id: string;
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  isBinary: boolean;
  language: string | null;
  additions: number;
  deletions: number;
  /** Raw "old mode"/"new mode" header lines, when git reported them. */
  mode?: string | null;
  hunks: Hunk[];
}

export interface Diff {
  files: DiffFile[];
  base?: string;
  head?: string;
}

export interface DiffSummary {
  fileCount: number;
  additions: number;
  deletions: number;
}

/** Which changes to show. `all` is the default and the superset. */
export type DiffMode = 'all' | 'branch' | 'working';
export const DEFAULT_DIFF_MODE: DiffMode = 'all';
export type ViewMode = 'split' | 'unified';
export type ColorMode = 'light' | 'dark' | 'auto';

/**
 * Where the "new" side of the diff comes from, for on-demand context
 * expansion: `WORKTREE` reads the on-disk file; anything else is a git rev
 * (`HEAD` or a local branch) passed to `git show`.
 */
export type Rev = 'WORKTREE' | string;

/** A local branch the compare pickers can switch to. */
export interface BranchInfo {
  name: string;
  /** True when this is the checked-out branch. */
  current: boolean;
  /** Upstream remote-tracking ref, e.g. `origin/main`, if configured. */
  upstream: string | null;
  /** Last time that upstream ref was updated (typically a fetch), ISO-8601. */
  fetchedAt: string | null;
}

export type CommentSide = 'new' | 'old' | 'file';
export type CommentAuthor = 'user' | 'claude';
export type CommentStatus = 'open' | 'resolved';
/** How strongly the author wants this comment acted on. */
export type CommentSeverity = 'note' | 'suggestion' | 'blocking';

export interface Comment {
  id: string;
  repoRoot: string;
  createdAt: string;
  updatedAt: string;
  status: CommentStatus;
  filePath: string;
  side: CommentSide;
  /** Both 0 when `side` is `file`. */
  startLine: number;
  endLine: number;
  body: string;
  /** Branch the comment was written on; null means unknown. */
  branch: string | null;
  /** The code as it looked when the comment was written. */
  lineSnapshot: string[];
  author: CommentAuthor;
  /** Set on replies; replies cannot themselves be replied to. */
  parentId: string | null;
}

/** Everything the caller supplies; the store owns identity and timestamps. */
export type CommentInput = Omit<Comment, 'id' | 'repoRoot' | 'createdAt' | 'updatedAt' | 'status'>;

export type CommentPatch = Partial<Pick<Comment, 'body' | 'status'>>;

/** A comment plus its rendered markdown, as returned over the API. */
export interface CommentWithHtml extends Comment {
  bodyHtml: string;
}

/**
 * The project a request is scoped to. `repoRoot` is the git toplevel, or null
 * when the path is not inside a repo (the sample diff is shown instead);
 * `displayPath` is what the UI shows and what tabs pass back as `?repo=`.
 */
export interface RepoScope {
  repoRoot: string | null;
  displayPath: string;
}
