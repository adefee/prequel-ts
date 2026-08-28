// Small DOM/URL helpers shared by the two client entry points.

export function escapeHtml(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `Element.closest` for an event target, which may not be an Element. */
export function closestFrom<E extends Element = HTMLElement>(
  target: EventTarget | null,
  selector: string
): E | null {
  return target instanceof Element ? target.closest<E>(selector) : null;
}

/** The project this tab is showing, as rendered into <html data-repo>. */
export function currentRepoPath(): string {
  return document.documentElement.dataset.repo ?? '';
}

/**
 * Scope an API URL to this tab's project. Without it the server would answer
 * for the path the CLI was started in, so tabs on different repos would bleed
 * into each other.
 */
export function withRepoQuery(url: string): string {
  const repo = currentRepoPath();
  if (!repo) return url;
  const u = new URL(url, location.origin);
  u.searchParams.set('repo', repo);
  return u.pathname + u.search;
}
