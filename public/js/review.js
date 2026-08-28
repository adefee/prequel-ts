// Interactivity: segmented toggles (view/diff), collapse/expand, copy path,
// "Viewed" state. Toggle choices persist in localStorage and are re-applied
// on loads where the URL doesn't pin them.

// Segmented toggles that persist across loads: display 'view' (split/unified)
// and 'diff' mode (all/branch/working). Each is re-applied on loads where the
// URL doesn't pin it.
const PERSIST_PARAMS = ['view', 'diff'];

// Navigate, setting `param=value` and preserving all other query params
// (including per-tab `repo`).
function goToParam(param, value) {
  if (PERSIST_PARAMS.includes(param)) localStorage.setItem('prequel:' + param, value);
  const params = new URLSearchParams(location.search);
  params.set(param, value);
  location.search = params.toString();
}

function currentRepoPath() {
  return document.documentElement.dataset.repo || '';
}

// Append/override the per-tab `repo` query param on an API URL.
function withRepoQuery(url) {
  const repo = currentRepoPath();
  if (!repo) return url;
  const u = new URL(url, location.origin);
  u.searchParams.set('repo', repo);
  return u.pathname + u.search;
}

// Validate `path` then navigate this tab to it via ?repo= (other tabs untouched).
async function navigateToRepo(path, { saveShortcut = false } = {}) {
  const res = await fetch('/api/repo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Could not change path');
    err.status = res.status;
    throw err;
  }
  if (saveShortcut) addShortcut(data.displayPath);
  const params = new URLSearchParams(location.search);
  params.set('repo', data.displayPath);
  location.search = params.toString();
  return data;
}

// On load, honor saved preferences for params not pinned in the URL.
(function applySavedParams() {
  const params = new URLSearchParams(location.search);
  let changed = false;
  for (const param of PERSIST_PARAMS) {
    if (params.has(param)) continue; // explicit choice in URL wins
    const saved = localStorage.getItem('prequel:' + param);
    const rendered = document.documentElement.getAttribute('data-' + param);
    if (saved && saved !== rendered) {
      params.set(param, saved);
      changed = true;
    }
  }
  // Pin this tab's project into the URL so duplicate tabs / bookmarks stay
  // independent of the CLI default and of other open tabs.
  const repo = currentRepoPath();
  if (repo && !params.has('repo')) {
    params.set('repo', repo);
    changed = true;
  }
  if (changed) location.replace(location.pathname + '?' + params.toString());
})();

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Build a context (unchanged) row matching the current table layout.
function contextRow(split, oldNo, newNo, inner) {
  const code =
    '<td class="blob-code blob-code-context"><span class="blob-code-inner">' +
    '<span class="marker"> </span>' + inner + '</span></td>';
  const numOld = `<td class="blob-num blob-num-context" data-line-number="${oldNo}"></td>`;
  const numNew = `<td class="blob-num blob-num-context" data-line-number="${newNo}"></td>`;
  return split
    ? `<tr class="context-loaded">${numOld}${code}${numNew}${code}</tr>`
    : `<tr class="context-loaded">${numOld}${numNew}${code}</tr>`;
}

function disableExpander(row) {
  row.removeAttribute('data-expander');
  const btn = row.querySelector('.expander');
  if (btn) btn.remove();
}

const CHUNK = 20;

async function expandContext(btn) {
  const row = btn.closest('tr[data-expander]');
  if (!row || row.dataset.loading) return;
  const { path, rev } = row.dataset;
  const newStart = parseInt(row.dataset.newStart, 10);
  const oldStart = parseInt(row.dataset.oldStart, 10);
  const prevNewEnd = parseInt(row.dataset.prevNewEnd, 10) || 0;
  const offset = oldStart - newStart; // oldNo = newNo + offset (constant in a gap)
  const gapEndNew = newStart - 1;
  const bounded = prevNewEnd > 0; // gap between two hunks (fully known)
  const gapStartNew = bounded ? prevNewEnd + 1 : Math.max(1, gapEndNew - CHUNK + 1);
  if (gapEndNew < gapStartNew) {
    disableExpander(row);
    return;
  }

  const split = row.closest('table').classList.contains('diff-table-split');
  row.dataset.loading = '1';
  try {
    const res = await fetch(
      withRepoQuery(
        `/api/context?path=${encodeURIComponent(path)}&rev=${rev}` +
          `&start=${gapStartNew}&end=${gapEndNew}`
      )
    );
    const data = await res.json();
    const lines = data.lines || [];
    let frag = '';
    lines.forEach((content, i) => {
      const n = data.from + i;
      const inner = data.html ? data.html[i] : escapeHtml(content);
      frag += contextRow(split, n + offset, n, inner);
    });
    if (frag) row.insertAdjacentHTML('beforebegin', frag);

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
function syncSubnavHeight() {
  const subnav = document.querySelector('.pr-subnav');
  if (subnav) {
    document.documentElement.style.setProperty('--subnav-h', subnav.offsetHeight + 'px');
  }
}
syncSubnavHeight();
window.addEventListener('resize', syncSubnavHeight);
window.addEventListener('load', syncSubnavHeight);

// --- file tree ----------------------------------------------------------
const TREE_KEY = 'prequel:tree'; // 'hidden' | 'shown'

function markTreeViewed(id, viewed) {
  const row = document.querySelector(`.tree-file-row[data-file-id="${id}"]`);
  if (row) row.classList.toggle('is-viewed', viewed);
}

function setActiveTreeFile(id) {
  document
    .querySelectorAll('.tree-file-row.is-active')
    .forEach((r) => r.classList.remove('is-active'));
  const row = document.querySelector(`.tree-file-row[data-file-id="${id}"]`);
  if (row) row.classList.add('is-active');
}

(function applyTreeState() {
  if (localStorage.getItem(TREE_KEY) === 'hidden') {
    document.querySelector('.review-layout')?.classList.add('tree-hidden');
  }
})();

// --- resizable file pane (drag the divider; width persists) --------------
const TREE_W_KEY = 'prequel:tree-w';
const TREE_W_MIN = 180;
const treeWMax = () => Math.min(800, Math.round(window.innerWidth * 0.6));

function setTreeWidth(px) {
  const w = Math.max(TREE_W_MIN, Math.min(treeWMax(), Math.round(px)));
  document.querySelector('.review-layout')?.style.setProperty('--tree-w', w + 'px');
  return w;
}

(function applySavedTreeWidth() {
  const saved = parseInt(localStorage.getItem(TREE_W_KEY), 10);
  if (Number.isFinite(saved)) setTreeWidth(saved);
})();

(function initTreeResizer() {
  const resizer = document.querySelector('.tree-resizer');
  const pane = document.querySelector('.file-tree-pane');
  if (!resizer || !pane) return;

  let startX = 0;
  let startW = 0;

  const onMove = (e) => {
    setTreeWidth(startW + (e.clientX - startX));
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    resizer.classList.remove('is-dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    const w = parseInt(getComputedStyle(pane).width, 10);
    if (Number.isFinite(w)) localStorage.setItem(TREE_W_KEY, String(w));
  };

  resizer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startW = parseInt(getComputedStyle(pane).width, 10) || 300;
    resizer.classList.add('is-dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // double-click the divider to reset to the default width
  resizer.addEventListener('dblclick', () => {
    document.querySelector('.review-layout')?.style.removeProperty('--tree-w');
    localStorage.removeItem(TREE_W_KEY);
  });
})();

document.addEventListener('click', (e) => {
  // Hunk context expander
  const expander = e.target.closest('.expander');
  if (expander) {
    e.preventDefault();
    expandContext(expander);
    return;
  }

  // Toggle the file-tree pane
  const treeToggle = e.target.closest('.tree-pane-toggle');
  if (treeToggle) {
    const layout = document.querySelector('.review-layout');
    const hidden = layout.classList.toggle('tree-hidden');
    localStorage.setItem(TREE_KEY, hidden ? 'hidden' : 'shown');
    return;
  }

  // Collapse/expand a tree folder
  const dirRow = e.target.closest('.tree-dir-row');
  if (dirRow) {
    dirRow.closest('.tree-dir').classList.toggle('is-collapsed');
    return;
  }

  // Click a file in the tree → scroll to it (anchor handles scroll)
  const fileRow = e.target.closest('.tree-file-row');
  if (fileRow) {
    setActiveTreeFile(fileRow.getAttribute('data-file-id'));
    // let the default #anchor navigation scroll to the file
    return;
  }

  // Segmented toggles (Unified/Split, All/Branch/Working)
  const segBtn = e.target.closest('.seg-btn');
  if (segBtn) {
    e.preventDefault();
    goToParam(segBtn.getAttribute('data-param'), segBtn.getAttribute('data-value'));
    return;
  }

  // collapse/expand the whole file
  const collapse = e.target.closest('.collapse-btn');
  if (collapse) {
    const file = collapse.closest('.file');
    const collapsed = file.classList.toggle('is-collapsed');
    collapse.setAttribute('aria-expanded', String(!collapsed));
    return;
  }

  // copy file path
  const copyBtn = e.target.closest('.copy-path');
  if (copyBtn) {
    const path = copyBtn.getAttribute('data-path');
    navigator.clipboard?.writeText(path).then(
      () => flash(copyBtn),
      () => {}
    );
  }
});

function flash(el) {
  el.classList.add('copied');
  setTimeout(() => el.classList.remove('copied'), 800);
}

// --- saved project shortcuts (localStorage) -----------------------------
const SHORTCUTS_KEY = 'prequel:shortcuts';

function loadShortcuts() {
  try {
    const raw = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((p) => typeof p === 'string' && p.trim()) : [];
  } catch {
    return [];
  }
}

function saveShortcuts(list) {
  localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(list));
}

function addShortcut(path) {
  const next = path.trim();
  if (!next) return;
  const list = loadShortcuts().filter((p) => p !== next);
  list.unshift(next);
  saveShortcuts(list.slice(0, 30));
}

function removeShortcut(path) {
  saveShortcuts(loadShortcuts().filter((p) => p !== path));
}

// Click the header path → inline input → Enter switches *this tab's* repo.
(function initRepoPathEditor() {
  const btn = document.querySelector('.repo-path');
  if (!btn) return;
  let editing = false;

  function showError(input, message) {
    input.classList.add('is-error');
    input.title = message || 'Could not change path';
  }

  function startEdit(initialValue) {
    if (editing) return;
    editing = true;
    const current = btn.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'repo-path-input';
    input.value = initialValue != null ? initialValue : current;
    input.setAttribute('aria-label', 'Project path');
    input.spellcheck = false;
    btn.replaceWith(input);
    input.focus();
    input.select();

    const cancel = () => {
      if (!editing) return;
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
      input.classList.remove('is-error');
      input.title = '';
      try {
        await navigateToRepo(next);
      } catch (err) {
        input.disabled = false;
        showError(input, err.message || 'Could not change path');
        input.focus();
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (editing && !input.disabled) cancel();
      }, 0);
    });
    syncSubnavHeight();
  }

  btn.addEventListener('click', () => startEdit());
  // Expose so the shortcuts menu can open the editor for "Add path…".
  btn._startEdit = startEdit;
})();

(function initRepoShortcuts() {
  const picker = document.querySelector('.repo-picker');
  const toggle = document.querySelector('.repo-shortcuts-toggle');
  const menu = document.querySelector('.repo-shortcuts-menu');
  const pathBtn = document.querySelector('.repo-path');
  if (!picker || !toggle || !menu || !pathBtn) return;

  function closeMenu() {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }

  function openMenu() {
    renderMenu();
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
  }

  function renderMenu() {
    const current = currentRepoPath();
    const shortcuts = loadShortcuts();
    menu.textContent = '';

    if (!shortcuts.length) {
      const empty = document.createElement('div');
      empty.className = 'repo-shortcut-empty';
      empty.textContent = 'No saved projects yet';
      menu.appendChild(empty);
    } else {
      for (const path of shortcuts) {
        const row = document.createElement('div');
        row.className = 'repo-shortcut-item' + (path === current ? ' is-current' : '');
        row.setAttribute('role', 'menuitem');

        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'repo-shortcut-label';
        label.textContent = path;
        label.title = path;
        label.addEventListener('click', async () => {
          closeMenu();
          if (path === current) return;
          try {
            await navigateToRepo(path);
          } catch (err) {
            window.alert(err.message || 'Could not open path');
          }
        });

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'repo-shortcut-remove';
        remove.title = 'Remove shortcut';
        remove.setAttribute('aria-label', 'Remove shortcut');
        remove.textContent = '×';
        remove.addEventListener('click', (e) => {
          e.stopPropagation();
          removeShortcut(path);
          renderMenu();
        });

        row.appendChild(label);
        row.appendChild(remove);
        menu.appendChild(row);
      }
    }

    const sep = document.createElement('div');
    sep.className = 'repo-shortcut-sep';
    sep.textContent = 'Actions';
    menu.appendChild(sep);

    const saveCurrent = document.createElement('button');
    saveCurrent.type = 'button';
    saveCurrent.className = 'repo-shortcut-action';
    saveCurrent.setAttribute('role', 'menuitem');
    const already = shortcuts.includes(current);
    saveCurrent.textContent = already ? 'Current path already saved' : 'Save current path';
    saveCurrent.disabled = already || !current;
    saveCurrent.addEventListener('click', () => {
      addShortcut(current);
      renderMenu();
    });
    menu.appendChild(saveCurrent);

    const addPath = document.createElement('button');
    addPath.type = 'button';
    addPath.className = 'repo-shortcut-action';
    addPath.setAttribute('role', 'menuitem');
    addPath.textContent = 'Add path…';
    addPath.addEventListener('click', () => {
      closeMenu();
      if (typeof pathBtn._startEdit === 'function') pathBtn._startEdit('');
      else pathBtn.click();
    });
    menu.appendChild(addPath);

    const saveAndOpen = document.createElement('button');
    saveAndOpen.type = 'button';
    saveAndOpen.className = 'repo-shortcut-action';
    saveAndOpen.setAttribute('role', 'menuitem');
    saveAndOpen.textContent = 'Add path and save…';
    saveAndOpen.addEventListener('click', () => {
      closeMenu();
      // Reuse the inline editor; on success navigateToRepo isn't called with
      // saveShortcut from the editor — wrap via a one-shot prompt flow:
      const next = window.prompt('Project path to open and save:', current || '');
      if (next == null) return;
      navigateToRepo(next.trim(), { saveShortcut: true }).catch((err) => {
        window.alert(err.message || 'Could not open path');
      });
    });
    menu.appendChild(saveAndOpen);
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu();
  });

  document.addEventListener('click', (e) => {
    if (!menu.hidden && !picker.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) closeMenu();
  });
})();

// "Viewed" checkboxes persist per file id in localStorage and collapse the file.
const VIEWED_KEY = 'prequel:viewed';
function loadViewed() {
  try {
    return JSON.parse(localStorage.getItem(VIEWED_KEY) || '{}');
  } catch {
    return {};
  }
}
function saveViewed(state) {
  localStorage.setItem(VIEWED_KEY, JSON.stringify(state));
}

const viewedState = loadViewed();
document.querySelectorAll('.viewed-checkbox').forEach((cb) => {
  const id = cb.getAttribute('data-file-id');
  if (viewedState[id]) {
    cb.checked = true;
    cb.closest('.file').classList.add('is-collapsed');
    markTreeViewed(id, true);
  }
  cb.addEventListener('change', () => {
    viewedState[id] = cb.checked;
    saveViewed(viewedState);
    cb.closest('.file').classList.toggle('is-collapsed', cb.checked);
    markTreeViewed(id, cb.checked);
  });
});
