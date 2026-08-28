// Client-side filter for the file tree. Matches GitHub's "Filter changed
// files" box: substring on the path, hide unmatched rows, and hide directories
// that no longer have a visible child.
//
// Rows use a class, not the `hidden` attribute: `.tree-row { display: flex }`
// beats the UA `[hidden] { display: none }` rule, so `el.hidden = true` would
// leave the row on screen.

const FILTERED = 'is-filtered-out';

export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

export function pathMatches(filePath: string, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  return filePath.toLowerCase().includes(q);
}

export function applyFileFilter(root: ParentNode, query: string): number {
  const q = normalizeQuery(query);
  let visible = 0;
  root.querySelectorAll<HTMLElement>('[data-file-path]').forEach((row) => {
    const path = row.dataset.filePath ?? row.textContent ?? '';
    const show = pathMatches(path, q);
    row.classList.toggle(FILTERED, !show);
    if (show) visible += 1;
  });
  root.querySelectorAll<HTMLElement>('.tree-dir').forEach((dir) => {
    const any = [...dir.querySelectorAll<HTMLElement>('[data-file-path]')].some(
      (r) => !r.classList.contains(FILTERED)
    );
    dir.classList.toggle(FILTERED, !any);
  });
  return visible;
}

export function initFileFilter(input: HTMLInputElement, tree: ParentNode): void {
  const empty = document.createElement('div');
  empty.className = 'tree-filter-empty';
  empty.hidden = true;
  empty.textContent = 'No files match';
  tree.appendChild(empty);

  const run = () => {
    const n = applyFileFilter(tree, input.value);
    empty.hidden = n > 0 || !normalizeQuery(input.value);
  };
  input.addEventListener('input', run);
  input.addEventListener('search', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      input.blur();
      run();
    }
  });
}
