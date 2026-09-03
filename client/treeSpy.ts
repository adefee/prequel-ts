// Highlight the file-tree row that matches the diff currently in view.
// The "current" file is the last visible .file whose top has crossed the
// sticky subnav line — the usual scroll-spy rule.

export interface FileOffset {
  id: string;
  top: number;
  visible: boolean;
}

export function pickActiveFileId(files: FileOffset[], threshold: number): string | null {
  let current: string | null = null;
  for (const file of files) {
    if (!file.visible) {
      continue;
    }
    if (current === null || file.top <= threshold) {
      current = file.id;
    } else {
      break;
    }
  }
  return current;
}

function fileIdOf(el: HTMLElement): string {
  return el.dataset.fileId || el.querySelector<HTMLElement>("[data-file-id]")?.dataset.fileId || "";
}

function scrollRowIntoPane(row: HTMLElement): void {
  const pane = row.closest<HTMLElement>(".file-tree-pane");
  if (!pane) {
    return;
  }
  const p = pane.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  if (r.top < p.top + 8) {
    pane.scrollTop += r.top - p.top - 8;
  } else if (r.bottom > p.bottom - 8) {
    pane.scrollTop += r.bottom - p.bottom + 8;
  }
}

function expandAncestors(row: HTMLElement): void {
  let dir = row.closest(".tree-dir");
  while (dir) {
    dir.classList.remove("is-collapsed");
    dir = dir.parentElement?.closest(".tree-dir") ?? null;
  }
}

export function setActiveTreeFile(id: string, { scrollTree = false } = {}): void {
  document.querySelectorAll(".tree-file-row.is-active").forEach((r) => {
    r.classList.remove("is-active");
    r.removeAttribute("aria-current");
  });
  const row = document.querySelector(`.tree-file-row[data-file-id="${CSS.escape(id)}"]`);
  if (!(row instanceof HTMLElement)) {
    return;
  }
  row.classList.add("is-active");
  row.setAttribute("aria-current", "true");
  if (scrollTree) {
    expandAncestors(row);
    scrollRowIntoPane(row);
  }
}

function subnavThreshold(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--subnav-h");
  return (parseInt(raw, 10) || 62) + 8;
}

export function initTreeSpy(): void {
  if (document.documentElement.dataset.treeSpy) {
    return;
  }
  const files = [...document.querySelectorAll<HTMLElement>(".file")];
  if (!files.length || !document.querySelector(".file-tree")) {
    return;
  }
  document.documentElement.dataset.treeSpy = "1";

  let lastId = "";
  let ticking = false;

  const apply = (): void => {
    ticking = false;
    const id = pickActiveFileId(
      files.map((el) => ({
        id: fileIdOf(el),
        top: el.getBoundingClientRect().top,
        visible: el.getClientRects().length > 0,
      })),
      subnavThreshold(),
    );
    if (!id || id === lastId) {
      return;
    }
    lastId = id;
    setActiveTreeFile(id, { scrollTree: true });
  };

  const onScroll = (): void => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(apply);
    }
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  document.addEventListener("prequel:files-changed", apply);
  apply();
}
