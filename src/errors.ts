// Errors that carry the HTTP status the API should answer with.

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof HttpError ? err.status : 500;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
