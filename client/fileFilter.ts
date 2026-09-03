// Client-side filter for the file tree. Matches GitHub's "Filter changed
// files" box: substring on the path, hide unmatched rows, and hide directories
// that no longer have a visible child. Also honors hide-test / hide-style
// toggles, which hide matching diffs too.
//
// Rows use a class, not the `hidden` attribute: `.tree-row { display: flex }`
// beats the UA `[hidden] { display: none }` rule, so `el.hidden = true` would
// leave the row on screen.

import { isStyleFile, isTestFile } from "../src/fileKinds";

export { isStyleFile, isTestFile };

const FILTERED = "is-filtered-out";
const TEST_HIDDEN = "is-test-hidden";
const STYLE_HIDDEN = "is-style-hidden";
const HIDE_TESTS_KEY = "prequel:test-files";
const HIDE_STYLES_KEY = "prequel:style-files";
const FILTER_QUERY_KEY = "prequel:file-filter";

export interface FileHideOptions {
  hideTestFiles?: boolean;
  hideStyleFiles?: boolean;
}

export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

export function pathMatches(filePath: string, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) {
    return true;
  }
  return filePath.toLowerCase().includes(q);
}

export function fileIsVisible(
  filePath: string,
  query: string,
  hide: FileHideOptions = {},
): boolean {
  if (hide.hideTestFiles && isTestFile(filePath)) {
    return false;
  }
  if (hide.hideStyleFiles && isStyleFile(filePath)) {
    return false;
  }
  return pathMatches(filePath, query);
}

export function applyFileFilter(
  root: ParentNode,
  query: string,
  hide: FileHideOptions = {},
): number {
  let visible = 0;
  root.querySelectorAll<HTMLElement>("[data-file-path]").forEach((row) => {
    const path = row.dataset.filePath ?? row.textContent ?? "";
    const show = fileIsVisible(path, query, hide);
    row.classList.toggle(FILTERED, !show);
    if (show) {
      visible += 1;
    }
  });
  root.querySelectorAll<HTMLElement>(".tree-dir").forEach((dir) => {
    const any = [...dir.querySelectorAll<HTMLElement>("[data-file-path]")].some(
      (r) => !r.classList.contains(FILTERED),
    );
    dir.classList.toggle(FILTERED, !any);
  });
  return visible;
}

export function applyKindDiffVisibility(filesRoot: ParentNode, hide: FileHideOptions): void {
  filesRoot.querySelectorAll<HTMLElement>(".file[data-path]").forEach((el) => {
    const path = el.dataset.path ?? "";
    el.classList.toggle(TEST_HIDDEN, Boolean(hide.hideTestFiles && isTestFile(path)));
    el.classList.toggle(STYLE_HIDDEN, Boolean(hide.hideStyleFiles && isStyleFile(path)));
  });
}

function bindPersistedToggle(toggle: HTMLInputElement | null | undefined, key: string): void {
  if (!toggle) {
    return;
  }
  toggle.checked = localStorage.getItem(key) === "hidden";
  toggle.addEventListener("change", () => {
    localStorage.setItem(key, toggle.checked ? "hidden" : "shown");
  });
}

export function initFileFilter(
  input: HTMLInputElement,
  tree: ParentNode,
  toggles: {
    hideTests?: HTMLInputElement | null;
    hideStyles?: HTMLInputElement | null;
  } = {},
): void {
  const empty = document.createElement("div");
  empty.className = "tree-filter-empty";
  empty.hidden = true;
  empty.textContent = "No files match";
  tree.appendChild(empty);

  bindPersistedToggle(toggles.hideTests, HIDE_TESTS_KEY);
  bindPersistedToggle(toggles.hideStyles, HIDE_STYLES_KEY);

  try {
    const saved = localStorage.getItem(FILTER_QUERY_KEY);
    if (saved != null) {
      input.value = saved;
    }
  } catch {
    /* private mode / quota — leave the field empty */
  }

  const run = () => {
    const hide: FileHideOptions = {
      hideTestFiles: toggles.hideTests?.checked ?? false,
      hideStyleFiles: toggles.hideStyles?.checked ?? false,
    };
    try {
      localStorage.setItem(FILTER_QUERY_KEY, input.value);
    } catch {
      /* ignore */
    }
    const n = applyFileFilter(tree, input.value, hide);
    applyKindDiffVisibility(document, hide);
    empty.hidden =
      n > 0 || !(normalizeQuery(input.value) || hide.hideTestFiles || hide.hideStyleFiles);
    document.dispatchEvent(new Event("prequel:files-changed"));
  };
  input.addEventListener("input", run);
  input.addEventListener("search", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      input.blur();
      run();
    }
  });
  toggles.hideTests?.addEventListener("change", run);
  toggles.hideStyles?.addEventListener("change", run);
  run();
}
