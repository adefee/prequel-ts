// Interactivity: segmented toggles (view/diff), collapse/expand, copy path,
// "Viewed" state, hunk-context expansion, the project picker, and branch
// compare pickers. Toggle choices persist in localStorage and are re-applied
// on loads where the URL doesn't pin them.

import { closestFrom, currentRepoPath, escapeHtml, withRepoQuery } from "./dom";
import { initFileFilter } from "./fileFilter";

/** What `/api/context` returns for a hunk-expansion request. */
interface ContextResponse {
  from: number;
  eof: boolean;
  lines: string[];
  html: string[] | null;
}

/** What `/api/repo` returns after validating a path. */
interface RepoSwitchResponse {
  ok: boolean;
  repoRoot: string | null;
  displayPath: string;
  isRepo: boolean;
  error?: string;
}

// Segmented toggles that persist across loads: display 'view' (split/unified)
// and 'diff' mode (all/branch/working). Each is re-applied on loads where the
// URL doesn't pin it.
const PERSIST_PARAMS = ["view", "diff"];

function markPageLoading(): void {
  document.documentElement.classList.add("is-loading");
  document.getElementById("page-progress")?.classList.add("is-active");
}

function clearPageLoading(): void {
  document.documentElement.classList.remove("is-loading");
  if (!document.documentElement.classList.contains("is-booting")) {
    document.getElementById("page-progress")?.classList.remove("is-active");
  }
}

window.addEventListener("pageshow", clearPageLoading);

// Navigate, setting `param=value` and preserving all other query params
// (including per-tab `repo`).
function goToParam(param: string, value: string): void {
  if (PERSIST_PARAMS.includes(param)) {
    localStorage.setItem("prequel:" + param, value);
  }
  const params = new URLSearchParams(location.search);
  params.set(param, value);
  markPageLoading();
  location.search = params.toString();
}

// Validate `path` then navigate this tab to it via ?repo= (other tabs untouched).
async function navigateToRepo(
  repoPath: string,
  { saveShortcut = false }: { saveShortcut?: boolean } = {},
): Promise<RepoSwitchResponse> {
  const res = await fetch("/api/repo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: repoPath }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<RepoSwitchResponse>;
  if (!res.ok || !data.displayPath) {
    throw new Error(data.error || "Could not change path");
  }
  if (saveShortcut) {
    addShortcut(data.displayPath);
  }
  const params = new URLSearchParams(location.search);
  params.set("repo", data.displayPath);
  markPageLoading();
  location.search = params.toString();
  return data as RepoSwitchResponse;
}

// On load, honor saved preferences for params not pinned in the URL.
function applySavedParams(): void {
  const params = new URLSearchParams(location.search);
  let changed = false;
  for (const param of PERSIST_PARAMS) {
    if (params.has(param)) {
      continue;
    } // explicit choice in URL wins
    const saved = localStorage.getItem("prequel:" + param);
    const rendered = document.documentElement.getAttribute("data-" + param);
    if (saved && saved !== rendered) {
      params.set(param, saved);
      changed = true;
    }
  }
  // Pin this tab's project into the URL so duplicate tabs / bookmarks stay
  // independent of the CLI default and of other open tabs.
  const repo = currentRepoPath();
  if (repo && !params.has("repo")) {
    params.set("repo", repo);
    changed = true;
  }
  if (changed) {
    markPageLoading();
    location.replace(location.pathname + "?" + params.toString());
  }
}
applySavedParams();

// --- hunk context expansion ---------------------------------------------
// Build a context (unchanged) row matching the current table layout.
function contextRow(split: boolean, oldNo: number, newNo: number, inner: string): string {
  const code =
    '<td class="blob-code blob-code-context"><span class="blob-code-inner">' +
    '<span class="marker"> </span>' +
    inner +
    "</span></td>";
  const numOld = `<td class="blob-num blob-num-context" data-line-number="${oldNo}"></td>`;
  const numNew = `<td class="blob-num blob-num-context" data-line-number="${newNo}"></td>`;
  return split
    ? `<tr class="context-loaded">${numOld}${code}${numNew}${code}</tr>`
    : `<tr class="context-loaded">${numOld}${numNew}${code}</tr>`;
}

function disableExpander(row: HTMLElement): void {
  row.removeAttribute("data-expander");
  row.querySelector(".expander")?.remove();
}

const CHUNK = 20;

async function expandContext(btn: Element): Promise<void> {
  const row = btn.closest<HTMLElement>("tr[data-expander]");
  if (!row || row.dataset.loading) {
    return;
  }
  const filePath = row.dataset.path;
  const rev = row.dataset.rev;
  if (!filePath || !rev) {
    return;
  }
  const newStart = parseInt(row.dataset.newStart ?? "", 10);
  const oldStart = parseInt(row.dataset.oldStart ?? "", 10);
  const prevNewEnd = parseInt(row.dataset.prevNewEnd ?? "", 10) || 0;
  const offset = oldStart - newStart; // oldNo = newNo + offset (constant in a gap)
  const gapEndNew = newStart - 1;
  const bounded = prevNewEnd > 0; // gap between two hunks (fully known)
  const gapStartNew = bounded ? prevNewEnd + 1 : Math.max(1, gapEndNew - CHUNK + 1);
  if (gapEndNew < gapStartNew) {
    disableExpander(row);
    return;
  }

  const split = row.closest("table")?.classList.contains("diff-table-split") ?? false;
  row.dataset.loading = "1";
  try {
    const res = await fetch(
      withRepoQuery(
        `/api/context?path=${encodeURIComponent(filePath)}&rev=${encodeURIComponent(rev)}` +
          `&start=${gapStartNew}&end=${gapEndNew}`,
      ),
    );
    if (!res.ok) {
      throw new Error(`context ${res.status}`);
    }
    const data = (await res.json()) as ContextResponse;
    const lines = data.lines || [];
    let frag = "";
    lines.forEach((content, i) => {
      const n = data.from + i;
      const inner = data.html ? (data.html[i] ?? "") : escapeHtml(content);
      frag += contextRow(split, n + offset, n, inner);
    });
    if (frag) {
      row.insertAdjacentHTML("beforebegin", frag);
    }

    if (bounded || gapStartNew <= 1) {
      disableExpander(row); // gap fully filled (or reached top of file)
    } else {
      // top-of-file: continue upward on the next click
      row.dataset.newStart = String(gapStartNew);
      row.dataset.oldStart = String(gapStartNew + offset);
    }
  } catch {
    /* leave the expander in place so the user can retry */
  } finally {
    delete row.dataset.loading;
  }
}

// Keep --subnav-h in sync with the sticky subnav's real height (it changes if
// the header wraps), so sticky file headers and the tree pane offset correctly.
function syncSubnavHeight(): void {
  const subnav = document.querySelector<HTMLElement>(".pr-subnav");
  if (subnav) {
    document.documentElement.style.setProperty("--subnav-h", subnav.offsetHeight + "px");
  }
}
syncSubnavHeight();
window.addEventListener("resize", syncSubnavHeight);
window.addEventListener("load", syncSubnavHeight);

// --- file tree ----------------------------------------------------------
const TREE_KEY = "prequel:tree"; // 'hidden' | 'shown'

function reviewLayout(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".review-layout");
}

function markTreeViewed(id: string, viewed: boolean): void {
  const row = document.querySelector(`.tree-file-row[data-file-id="${CSS.escape(id)}"]`);
  row?.classList.toggle("is-viewed", viewed);
}

function setActiveTreeFile(id: string): void {
  document
    .querySelectorAll(".tree-file-row.is-active")
    .forEach((r) => r.classList.remove("is-active"));
  const row = document.querySelector(`.tree-file-row[data-file-id="${CSS.escape(id)}"]`);
  row?.classList.add("is-active");
}

if (localStorage.getItem(TREE_KEY) === "hidden") {
  reviewLayout()?.classList.add("tree-hidden");
}

// --- resizable file pane (drag the divider; width persists) --------------
const TREE_W_KEY = "prequel:tree-w";
const TREE_W_MIN = 180;
const treeWMax = () => Math.min(800, Math.round(window.innerWidth * 0.6));

function setTreeWidth(px: number): number {
  const w = Math.max(TREE_W_MIN, Math.min(treeWMax(), Math.round(px)));
  reviewLayout()?.style.setProperty("--tree-w", w + "px");
  return w;
}

const savedTreeWidth = parseInt(localStorage.getItem(TREE_W_KEY) ?? "", 10);
if (Number.isFinite(savedTreeWidth)) {
  setTreeWidth(savedTreeWidth);
}

function initTreeResizer(): void {
  const resizer = document.querySelector<HTMLElement>(".tree-resizer");
  const pane = document.querySelector<HTMLElement>(".file-tree-pane");
  if (!resizer || !pane) {
    return;
  }

  let startX = 0;
  let startW = 0;

  const onMove = (e: MouseEvent) => {
    setTreeWidth(startW + (e.clientX - startX));
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    resizer.classList.remove("is-dragging");
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    const w = parseInt(getComputedStyle(pane).width, 10);
    if (Number.isFinite(w)) {
      localStorage.setItem(TREE_W_KEY, String(w));
    }
  };

  resizer.addEventListener("mousedown", (e) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    startX = e.clientX;
    startW = parseInt(getComputedStyle(pane).width, 10) || 300;
    resizer.classList.add("is-dragging");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // double-click the divider to reset to the default width
  resizer.addEventListener("dblclick", () => {
    reviewLayout()?.style.removeProperty("--tree-w");
    localStorage.removeItem(TREE_W_KEY);
  });
}
initTreeResizer();

function flash(el: Element): void {
  el.classList.add("copied");
  setTimeout(() => el.classList.remove("copied"), 800);
}

document.addEventListener("click", (e) => {
  // Hunk context expander
  const expander = closestFrom(e.target, ".expander");
  if (expander) {
    e.preventDefault();
    void expandContext(expander);
    return;
  }

  // Toggle the file-tree pane
  if (closestFrom(e.target, ".tree-pane-toggle")) {
    const layout = reviewLayout();
    if (!layout) {
      return;
    }
    const hidden = layout.classList.toggle("tree-hidden");
    localStorage.setItem(TREE_KEY, hidden ? "hidden" : "shown");
    return;
  }

  // Collapse/expand a tree folder
  const dirRow = closestFrom(e.target, ".tree-dir-row");
  if (dirRow) {
    dirRow.closest(".tree-dir")?.classList.toggle("is-collapsed");
    return;
  }

  // Click a file in the tree → let the default #anchor navigation scroll to it
  const fileRow = closestFrom(e.target, ".tree-file-row");
  if (fileRow) {
    const id = fileRow.getAttribute("data-file-id");
    if (id) {
      setActiveTreeFile(id);
    }
    return;
  }

  // Segmented toggles (Unified/Split, All/Branch/Working)
  const segBtn = closestFrom(e.target, ".seg-btn");
  if (segBtn) {
    e.preventDefault();
    const param = segBtn.getAttribute("data-param");
    const value = segBtn.getAttribute("data-value");
    if (param && value) {
      goToParam(param, value);
    }
    return;
  }

  // Same-origin navigation that will re-render the diff (branch pills, etc.)
  const nav = closestFrom<HTMLAnchorElement>(e.target, "a[href]");
  if (nav && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !nav.target) {
    try {
      const next = new URL(nav.href, location.href);
      if (next.origin === location.origin && next.pathname === location.pathname) {
        markPageLoading();
      }
    } catch {
      /* ignore malformed hrefs */
    }
  }

  // collapse/expand the whole file
  const collapse = closestFrom(e.target, ".collapse-btn");
  if (collapse) {
    const file = collapse.closest(".file");
    if (!file) {
      return;
    }
    const collapsed = file.classList.toggle("is-collapsed");
    collapse.setAttribute("aria-expanded", String(!collapsed));
    return;
  }

  // copy file path
  const copyBtn = closestFrom(e.target, ".copy-path");
  if (copyBtn) {
    const filePath = copyBtn.getAttribute("data-path");
    if (filePath) {
      navigator.clipboard?.writeText(filePath).then(
        () => flash(copyBtn),
        () => {},
      );
    }
  }
});

// --- saved project shortcuts (localStorage) -----------------------------
const SHORTCUTS_KEY = "prequel:shortcuts";
const SHORTCUTS_MAX = 30;

function loadShortcuts(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) || "[]");
    return Array.isArray(raw)
      ? raw.filter((p): p is string => typeof p === "string" && !!p.trim())
      : [];
  } catch {
    return [];
  }
}

function saveShortcuts(list: string[]): void {
  localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(list));
}

function addShortcut(repoPath: string): void {
  const next = repoPath.trim();
  if (!next) {
    return;
  }
  const list = loadShortcuts().filter((p) => p !== next);
  list.unshift(next);
  saveShortcuts(list.slice(0, SHORTCUTS_MAX));
}

function removeShortcut(repoPath: string): void {
  saveShortcuts(loadShortcuts().filter((p) => p !== repoPath));
}

// --- branch compare pickers ---------------------------------------------
// Native <details> menus (server-rendered links). JS only closes them when
// the user clicks outside or presses Escape.
function closeBranchMenus(): void {
  document.querySelectorAll<HTMLDetailsElement>(".ref-details[open]").forEach((el) => {
    el.open = false;
  });
}

function initBranchPickers(): void {
  if (!document.querySelector(".ref-details")) {
    return;
  }
  document.addEventListener("click", (e) => {
    if (e.target instanceof Node && document.querySelector(".pr-refs")?.contains(e.target)) {
      return;
    }
    closeBranchMenus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeBranchMenus();
    }
  });
}

// --- project picker -----------------------------------------------------
// Clicking the header path opens an inline input; Enter switches *this tab's*
// project. The caret next to it lists saved projects.
function initRepoPicker(): void {
  const pathBtn = document.querySelector<HTMLButtonElement>(".repo-path");
  if (!pathBtn) {
    return;
  }
  const btn = pathBtn;

  let editing = false;

  const startEdit = (initialValue?: string): void => {
    if (editing) {
      return;
    }
    editing = true;
    const current = btn.textContent ?? "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "repo-path-input";
    input.value = initialValue ?? current;
    input.setAttribute("aria-label", "Project path");
    input.spellcheck = false;
    btn.replaceWith(input);
    input.focus();
    input.select();

    const cancel = () => {
      if (!editing) {
        return;
      }
      editing = false;
      input.replaceWith(btn);
      syncSubnavHeight();
    };

    const submit = async () => {
      const next = input.value.trim();
      if (!next || next === current) {
        cancel();
        return;
      }
      input.disabled = true;
      input.classList.remove("is-error");
      input.title = "";
      try {
        await navigateToRepo(next);
      } catch (err) {
        input.disabled = false;
        input.classList.add("is-error");
        input.title = err instanceof Error ? err.message : "Could not change path";
        input.focus();
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (editing && !input.disabled) {
          cancel();
        }
      }, 0);
    });
    syncSubnavHeight();
  };

  btn.addEventListener("click", () => startEdit());

  const pickerEl = document.querySelector<HTMLElement>(".repo-picker");
  const toggleEl = document.querySelector<HTMLButtonElement>(".repo-shortcuts-toggle");
  const menuEl = document.querySelector<HTMLElement>(".repo-shortcuts-menu");
  if (!pickerEl || !toggleEl || !menuEl) {
    return;
  }

  const closeMenu = () => {
    menuEl.hidden = true;
    toggleEl.setAttribute("aria-expanded", "false");
  };

  function shortcutRow(repoPath: string, current: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "repo-shortcut-item" + (repoPath === current ? " is-current" : "");
    row.setAttribute("role", "menuitem");

    const label = document.createElement("button");
    label.type = "button";
    label.className = "repo-shortcut-label";
    label.textContent = repoPath;
    label.title = repoPath;
    label.addEventListener("click", () => {
      closeMenu();
      if (repoPath === current) {
        return;
      }
      navigateToRepo(repoPath).catch((err: unknown) => {
        window.alert(err instanceof Error ? err.message : "Could not open path");
      });
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "repo-shortcut-remove";
    remove.title = "Remove shortcut";
    remove.setAttribute("aria-label", "Remove shortcut");
    remove.textContent = "×";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      removeShortcut(repoPath);
      renderMenu();
    });

    row.append(label, remove);
    return row;
  }

  function menuAction(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "repo-shortcut-action";
    btn.setAttribute("role", "menuitem");
    btn.textContent = label;
    btn.disabled = disabled;
    btn.addEventListener("click", onClick);
    return btn;
  }

  const renderMenu = (): void => {
    const current = currentRepoPath();
    const shortcuts = loadShortcuts();
    menuEl.textContent = "";

    if (!shortcuts.length) {
      const empty = document.createElement("div");
      empty.className = "repo-shortcut-empty";
      empty.textContent = "No saved projects yet";
      menuEl.appendChild(empty);
    } else {
      for (const repoPath of shortcuts) {
        menuEl.appendChild(shortcutRow(repoPath, current));
      }
    }

    const sep = document.createElement("div");
    sep.className = "repo-shortcut-sep";
    sep.textContent = "Actions";
    menuEl.appendChild(sep);

    const already = shortcuts.includes(current);
    menuEl.appendChild(
      menuAction(
        already ? "Current path already saved" : "Save current path",
        () => {
          addShortcut(current);
          renderMenu();
        },
        already || !current,
      ),
    );
    menuEl.appendChild(
      menuAction("Add path…", () => {
        closeMenu();
        startEdit("");
      }),
    );
    menuEl.appendChild(
      menuAction("Add path and save…", () => {
        closeMenu();
        const next = window.prompt("Project path to open and save:", current || "");
        if (next == null) {
          return;
        }
        navigateToRepo(next.trim(), { saveShortcut: true }).catch((err: unknown) => {
          window.alert(err instanceof Error ? err.message : "Could not open path");
        });
      }),
    );
  };

  toggleEl.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menuEl.hidden) {
      renderMenu();
      menuEl.hidden = false;
      toggleEl.setAttribute("aria-expanded", "true");
    } else {
      closeMenu();
    }
  });

  document.addEventListener("click", (e) => {
    if (!menuEl.hidden && e.target instanceof Node && !pickerEl.contains(e.target)) {
      closeMenu();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menuEl.hidden) {
      closeMenu();
    }
  });
}
initRepoPicker();
initBranchPickers();
const treeFilter = document.querySelector<HTMLInputElement>(".tree-filter");
const fileTree = document.querySelector(".file-tree");
if (treeFilter && fileTree) {
  initFileFilter(treeFilter, fileTree);
}

// --- "Viewed" checkboxes ------------------------------------------------
// Persist per file id in localStorage and collapse the file.
const VIEWED_KEY = "prequel:viewed";

function loadViewed(): Record<string, boolean> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(VIEWED_KEY) || "{}");
    return raw && typeof raw === "object" ? (raw as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveViewed(state: Record<string, boolean>): void {
  localStorage.setItem(VIEWED_KEY, JSON.stringify(state));
}

const viewedState = loadViewed();
document.querySelectorAll<HTMLInputElement>(".viewed-checkbox").forEach((cb) => {
  const id = cb.getAttribute("data-file-id");
  if (!id) {
    return;
  }
  if (viewedState[id]) {
    cb.checked = true;
    cb.closest(".file")?.classList.add("is-collapsed");
    markTreeViewed(id, true);
  }
  cb.addEventListener("change", () => {
    viewedState[id] = cb.checked;
    saveViewed(viewedState);
    cb.closest(".file")?.classList.toggle("is-collapsed", cb.checked);
    markTreeViewed(id, cb.checked);
  });
});
