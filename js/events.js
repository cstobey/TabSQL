import { state } from './state.js';
import { db } from './db-api.js';
import { escHtml, setStatus, nodeLabel, childrenOf, allDescendantIds, recomputeDupUrls } from './helpers.js';
import { syncFocusState, applyFocusHighlights } from './focus.js';
import { load, render } from './render.js';
import { openTagPicker } from './tags.js';
import { loadCfgTags } from './tags.js';
import { loadCfgActions } from './actions-cfg.js';

const treeEl = document.getElementById('tree');

// ── Click handler (select + collapse + double-click) ─────────────────────────

treeEl.addEventListener('click', e => {
  if (e.target.classList.contains('act')) return;

  const node = e.target.closest('.node');
  if (!node) return;
  const id = +node.dataset.id;
  const n  = state.nodeMap[id];

  if (e.target.classList.contains('toggle')) {
    if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
    render(state.allNodes, document.getElementById('search').value).catch(console.error);
    return;
  }

  state.selected = id;
  document.querySelectorAll('.node.selected').forEach(el => el.classList.remove('selected'));
  node.classList.add('selected');

  if (e.detail === 2) {
    if (n?.node_type === 'win' && !n.is_saved && n?.chrome_id) {
      chrome.windows.update(n.chrome_id, { focused: true });
    } else if (n?.node_type === 'win' && n.is_saved) {
      db.send('open_saved_window', { winNodeId: n.id })
        .then(() => scheduleRefresh())
        .catch(console.error);
    } else if (n?.is_open && n?.chrome_id) {
      chrome.tabs.get(n.chrome_id).then(tab => {
        chrome.tabs.update(n.chrome_id, { active: true });
        chrome.windows.update(tab.windowId, { focused: true });
      }).catch(() => {
        if (n.url) chrome.tabs.create({ url: n.url });
      });
    } else if (n?.node_type === 'tab' && n.is_saved && n?.url) {
      db.preOpenTab(n.id, n.url).catch(() => {}).finally(() => {
        chrome.tabs.create({ url: n.url });
      });
    }
  }
});

// ── Action buttons ────────────────────────────────────────────────────────────

treeEl.addEventListener('click', async e => {
  const btn = e.target.closest('.act');
  if (!btn) return;
  e.stopPropagation();

  const id = +btn.dataset.id;
  const n  = state.nodeMap[id];
  if (!n) return;

  if (btn.classList.contains('act-edit')) {
    const noteRow = treeEl.querySelector(`.note-row[data-note-for="${id}"]`);
    if (!noteRow || noteRow.classList.contains('editing')) return;
    const current = state.nodeMap[id]?.note_text || '';
    noteRow.classList.remove('empty');
    noteRow.classList.add('editing');
    noteRow.innerHTML = `<span class="note-bar">│</span>
      <input class="note-input" value="${escHtml(current)}" placeholder="Add a note…">
      <button class="act note-save" title="Save">✓</button>
      <button class="act note-cancel" title="Cancel">✕</button>`;
    const inp = noteRow.querySelector('.note-input');
    inp.focus();
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter')  noteRow.querySelector('.note-save').click();
      if (e.key === 'Escape') noteRow.querySelector('.note-cancel').click();
    });
    noteRow.querySelector('.note-save').addEventListener('click', async () => {
      const val = noteRow.querySelector('.note-input').value.trim();
      await db.upsertNode({ id, note_text: val || null });
      if (state.nodeMap[id]) state.nodeMap[id].note_text = val || null;
      noteRow.classList.remove('editing');
      if (val) {
        noteRow.classList.remove('empty');
        noteRow.innerHTML = `<span class="note-bar">│</span><span class="note-text">${escHtml(val)}</span>`;
      } else {
        noteRow.classList.add('empty');
        noteRow.innerHTML = `<span class="note-bar">│</span><span class="note-text"></span>`;
      }
    });
    noteRow.querySelector('.note-cancel').addEventListener('click', () => {
      noteRow.classList.remove('editing');
      if (current) {
        noteRow.classList.remove('empty');
        noteRow.innerHTML = `<span class="note-bar">│</span><span class="note-text">${escHtml(current)}</span>`;
      } else {
        noteRow.classList.add('empty');
        noteRow.innerHTML = `<span class="note-bar">│</span><span class="note-text"></span>`;
      }
    });
    return;
  }

  if (btn.classList.contains('act-save')) {
    if (n.chrome_id) {
      try { await chrome.tabs.remove(n.chrome_id); } catch {}
    }
    await db.upsertNode({ id, node_type: 'tab', is_saved: 1, is_open: 0, chrome_id: null });
    scheduleRefresh();
    return;
  }

  if (btn.classList.contains('act-save-win')) {
    await db.send('save_window', { winNodeId: id });
    scheduleRefresh();
    return;
  }

  if (btn.classList.contains('act-pin')) {
    await db.send('set_tab_pinned', { nodeId: id, pinned: !n.is_pinned });
    scheduleRefresh();
    return;
  }

  if (btn.classList.contains('act-del')) {
    const descIds = allDescendantIds(id);
    if (n.node_type === 'win' && !n.is_saved && n.chrome_id) {
      try { await chrome.windows.remove(n.chrome_id); } catch {}
    } else if (n.chrome_id && n.is_open) {
      try { await chrome.tabs.remove(n.chrome_id); } catch {}
    }
    await db.deleteNode(id);
    state.allNodes = state.allNodes.filter(x => !descIds.has(x.id));
    state.nodeMap  = Object.fromEntries(state.allNodes.map(x => [x.id, x]));
    recomputeDupUrls();
    await render(state.allNodes, document.getElementById('search').value);
  }
});

// ── Context menu ──────────────────────────────────────────────────────────────

const ctx = document.getElementById('ctx');

treeEl.addEventListener('contextmenu', e => {
  e.preventDefault();
  const node = e.target.closest('.node');
  if (!node) return;
  state.selected = +node.dataset.id;
  ctx.style.left = e.clientX + 'px';
  ctx.style.top  = e.clientY + 'px';
  ctx._lastX = e.clientX;
  ctx._lastY = e.clientY;
  ctx.classList.remove('hidden');
  document.getElementById('tag-picker').classList.add('hidden');
});

document.addEventListener('click', e => {
  ctx.classList.add('hidden');
  if (!e.target.closest('#tag-picker')) {
    document.getElementById('tag-picker').classList.add('hidden');
    state.tagPickerNodeId = null;
  }
});

ctx.addEventListener('click', async e => {
  const action = e.target.dataset.action;
  if (!action || !state.selected) return;
  const n = state.nodeMap[state.selected];

  if (action === 'open' && n?.url) {
    chrome.tabs.create({ url: n.url });
  } else if (action === 'open-all') {
    for (const k of childrenOf(state.selected)) if (k.url) chrome.tabs.create({ url: k.url });
  } else if (action === 'copy-url' && n?.url) {
    await navigator.clipboard.writeText(n.url);
  } else if (action === 'copy-title') {
    await navigator.clipboard.writeText(nodeLabel(n));
  } else if (action === 'tags') {
    ctx.classList.add('hidden');
    openTagPicker(state.selected, ctx._lastX, ctx._lastY);
  } else if (action === 'delete') {
    const descIds = allDescendantIds(state.selected);
    const kidCount = descIds.size - 1;
    const suffix = kidCount > 0 ? ` and ${kidCount} child node${kidCount > 1 ? 's' : ''}` : '';
    if (confirm(`Delete "${nodeLabel(n)}"${suffix}?`)) {
      if (n.node_type === 'win' && !n.is_saved && n.chrome_id) {
        try { await chrome.windows.remove(n.chrome_id); } catch {}
      } else if (n.chrome_id && n.is_open) {
        try { await chrome.tabs.remove(n.chrome_id); } catch {}
      }
      await db.deleteNode(state.selected);
      state.allNodes = state.allNodes.filter(x => !descIds.has(x.id));
      state.nodeMap  = Object.fromEntries(state.allNodes.map(x => [x.id, x]));
      recomputeDupUrls();
      await render(state.allNodes, document.getElementById('search').value);
    }
  }
});

// ── Drag & drop ───────────────────────────────────────────────────────────────

let dropState = null;

treeEl.addEventListener('dragstart', e => {
  const node = e.target.closest('.node');
  if (!node) return;
  state.dragSrcId = +node.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(state.dragSrcId));
  setTimeout(() => node.classList.add('dragging'), 0);
});

treeEl.addEventListener('dragend', () => {
  treeEl.querySelectorAll('.dragging, .drag-over').forEach(el => {
    el.classList.remove('dragging', 'drag-over');
  });
  state.dragSrcId = null;
  dropState = null;
});

treeEl.addEventListener('dragover', e => {
  if (!state.dragSrcId) return;
  const node = e.target.closest('.node');
  if (!node) return;
  const targetId = +node.dataset.id;
  if (targetId === state.dragSrcId) return;

  const treeRect  = treeEl.getBoundingClientRect();
  const mouseX    = e.clientX - treeRect.left;
  const indentPx  = parseInt(node.style.paddingLeft) || 4;
  const nodeLevel = Math.round((indentPx - 4) / 16);
  const hoverLevel = Math.max(0, Math.floor((mouseX - 4) / 16));

  let parentId;
  if (hoverLevel >= nodeLevel) {
    parentId = targetId;
  } else {
    const stepsUp = nodeLevel - hoverLevel;
    let cur = state.nodeMap[targetId];
    for (let i = 0; i < stepsUp; i++) {
      cur = cur?.parent_id != null ? state.nodeMap[cur.parent_id] : null;
    }
    parentId = cur?.id ?? null;
  }

  if (parentId != null && allDescendantIds(state.dragSrcId).has(parentId)) return;

  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  dropState = { parentId };

  treeEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  if (parentId != null) {
    treeEl.querySelector(`[data-id="${parentId}"]`)?.classList.add('drag-over');
  }
});

treeEl.addEventListener('dragleave', e => {
  if (!treeEl.contains(e.relatedTarget)) {
    treeEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    dropState = null;
  }
});

treeEl.addEventListener('drop', async e => {
  e.preventDefault();
  if (!state.dragSrcId || !dropState) return;
  treeEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  const { parentId } = dropState;
  dropState = null;
  const siblings = childrenOf(parentId).filter(n => n.id !== state.dragSrcId);
  const orderBy = siblings.length > 0 ? siblings[siblings.length - 1].order_by + 1 : 0;
  await db.moveNode(state.dragSrcId, parentId, orderBy);
  state.dragSrcId = null;
  load();
});

// ── Search ────────────────────────────────────────────────────────────────────

let searchTimer = null;
document.getElementById('search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => render(state.allNodes, e.target.value.trim()).catch(console.error), 200);
});

// ── Toolbar buttons ───────────────────────────────────────────────────────────

document.getElementById('btn-refresh').addEventListener('click', async () => {
  await db.resync();
  await syncFocusState();
  await load();
});

// ── Live updates ──────────────────────────────────────────────────────────────

let liveTimer = null;
export function scheduleRefresh() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(load, 600);
}

chrome.tabs.onCreated.addListener(scheduleRefresh);
chrome.tabs.onRemoved.addListener(scheduleRefresh);
chrome.tabs.onUpdated.addListener(scheduleRefresh);
chrome.windows.onCreated.addListener(scheduleRefresh);
chrome.windows.onRemoved.addListener(scheduleRefresh);

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  for (const chromeId of [...state.focusState.activeTabChromeIds]) {
    const node = state.allNodes.find(n => n.chrome_id === chromeId);
    if (node) {
      const parentWin = state.nodeMap[node.parent_id];
      if (parentWin && parentWin.chrome_id === windowId) {
        state.focusState.activeTabChromeIds.delete(chromeId);
      }
    }
  }
  state.focusState.activeTabChromeIds.add(tabId);
  applyFocusHighlights();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  state.focusState.focusedWinChromeId = windowId > 0 ? windowId : null;
  applyFocusHighlights();
});

// ── Search toolbar action buttons ─────────────────────────────────────────────

document.getElementById('btn-search-window').addEventListener('click', async () => {
  const q = document.getElementById('search').value.trim();
  if (!q) return;
  const r = await db.send('open_search_in_window', { q });
  setStatus(`Moved ${r?.moved ?? 0} tabs to new window`);
  scheduleRefresh();
});

document.getElementById('btn-save-search').addEventListener('click', async () => {
  const q = document.getElementById('search').value.trim();
  if (!q) return;
  const r = await db.send('save_close_search', { q });
  setStatus(`Saved and closed ${r?.count ?? 0} tabs`);
  scheduleRefresh();
});

document.getElementById('btn-close-search').addEventListener('click', async () => {
  const q = document.getElementById('search').value.trim();
  if (!q) return;
  const r = await db.send('close_search', { q });
  setStatus(`Closed ${r?.count ?? 0} tabs`);
  scheduleRefresh();
});

// ── Config section expand/collapse ────────────────────────────────────────────

document.querySelectorAll('.cfg-hdr').forEach(hdr => {
  hdr.addEventListener('click', () => {
    const body = document.getElementById(hdr.dataset.target);
    const wasHidden = body.classList.contains('hidden');
    hdr.classList.toggle('collapsed', body.classList.toggle('hidden'));
    if (wasHidden) {
      if (hdr.dataset.target === 'cfg-tags-body')    loadCfgTags();
      if (hdr.dataset.target === 'cfg-actions-body') loadCfgActions();
    }
  });
});
