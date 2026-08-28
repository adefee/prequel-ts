// Errors that carry the HTTP status the API should answer with.

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof HttpError ? err.status : 500;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Stable codes for the UI and the Claude skill to branch on. */
export type ErrorCode = "bad-params" | "not-found" | "no-repo" | "cross-origin" | "body-too-large";

export function codeOf(err: unknown): ErrorCode | null {
  if (!(err instanceof HttpError)) {
    return null;
  }
  if (err.status === 404) {
    return "not-found";
  }
  if (err.status === 403) {
    return "cross-origin";
  }
  if (err.status === 413) {
    return "body-too-large";
  }
  if (/no repo/i.test(err.message)) {
    return "no-repo";
  }
  if (err.status === 400) {
    return "bad-params";
  }
  return null;
}
