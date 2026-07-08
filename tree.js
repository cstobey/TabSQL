// tree.js - sidebar UI
'use strict';

// ── DB API ────────────────────────────────────────────────────────────────────

const db = {
  async send(cmd, payload = {}) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('background not responding')), 8000);
      chrome.runtime.sendMessage({ to: 'background', cmd, payload }, r => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
        else if (r?.ok === false) rej(new Error(r.error));
        else res(r?.data);
      });
    });
  },
  query(sql)                        { return this.send('bulk_exec', { sql }); },
  deleteNode(id)                    { return this.send('delete_node', { id }); },
  moveNode(id, parent_id, position) { return this.send('move_node', { id, parent_id, position }); },
  upsertNode(node)                  { return this.send('upsert_node', { node }); },
  preOpenTab(nodeId, url)           { return this.send('pre_open_tab', { nodeId, url }); },
  resync()                           { return this.send('resync'); },
};

// ── State ─────────────────────────────────────────────────────────────────────

let allNodes    = [];
let nodeMap     = {};
let collapsed   = new Set();
let selected    = null;
let dragSrcId   = null;
let allTags     = [];          // [{id, name, color}]
let nodeTagsMap = {};          // nodeId → [{id, name, color}]
let dupUrls    = new Set();    // URLs that appear more than once in the tree
let tagPickerNodeId = null;    // which node the tag picker is open for
let focusState = { activeTabChromeIds: new Set(), focusedWinChromeId: null };

// ── Focus state ───────────────────────────────────────────────────────────────

async function syncFocusState() {
  const wins = await chrome.windows.getAll({ populate: true }).catch(() => []);
  focusState.activeTabChromeIds = new Set();
  focusState.focusedWinChromeId = null;
  for (const w of wins) {
    if (w.focused) focusState.focusedWinChromeId = w.id;
    for (const t of (w.tabs ?? [])) {
      if (t.active) focusState.activeTabChromeIds.add(t.id);
    }
  }
}

function applyFocusHighlights() {
  treeEl.querySelectorAll('.focus-active').forEach(el => el.classList.remove('focus-active'));
  for (const chromeId of focusState.activeTabChromeIds) {
    const node = allNodes.find(n => n.chrome_id === chromeId);
    if (node) treeEl.querySelector(`[data-id="${node.id}"]`)?.classList.add('focus-active');
  }
  if (focusState.focusedWinChromeId) {
    const winNode = allNodes.find(n => n.node_type === 'win' && !n.is_saved && n.chrome_id === focusState.focusedWinChromeId);
    if (winNode) treeEl.querySelector(`[data-id="${winNode.id}"]`)?.classList.add('focus-active');
  }
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function load() {
  setStatus('Loading…');
  try {
    await syncFocusState();
    const [all, tagsR, nodeTagsR] = await Promise.all([
      db.query('SELECT * FROM node ORDER BY parent_id NULLS FIRST, position'),
      db.send('get_tags'),
      db.send('get_all_node_tags'),
    ]);
    allNodes = all?.rows ?? [];
    nodeMap  = Object.fromEntries(allNodes.map(n => [n.id, n]));
    const urlCounts = {};
    for (const n of allNodes) if (n.url) urlCounts[n.url] = (urlCounts[n.url] || 0) + 1;
    dupUrls = new Set(Object.keys(urlCounts).filter(u => urlCounts[u] > 1));
    allTags  = tagsR?.rows ?? [];
    nodeTagsMap = {};
    for (const nt of (nodeTagsR?.rows ?? [])) {
      if (!nodeTagsMap[nt.node_id]) nodeTagsMap[nt.node_id] = [];
      nodeTagsMap[nt.node_id].push({ id: nt.id, name: nt.name, color: nt.color });
    }
    render(allNodes);
    setStatus(`${allNodes.length} nodes`);
  } catch(e) {
    setStatus('Error: ' + e.message);
    console.error(e);
  }
}

async function loadTags() {
  const r = await db.send('get_tags');
  allTags = r?.rows ?? [];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function childrenOf(parentId) {
  return allNodes.filter(n => n.parent_id == parentId).sort((a, b) => a.position - b.position);
}

function allDescendantIds(nodeId) {
  const ids = new Set([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const pid = queue.shift();
    childrenOf(pid).forEach(c => { ids.add(c.id); queue.push(c.id); });
  }
  return ids;
}

function recomputeDupUrls() {
  const urlCounts = {};
  for (const n of allNodes) if (n.url) urlCounts[n.url] = (urlCounts[n.url] || 0) + 1;
  dupUrls = new Set(Object.keys(urlCounts).filter(u => urlCounts[u] > 1));
}

function nodeIcon(n) {
  switch(n.node_type) {
    case 'win':          return n.is_saved ? '📁' : (n.relicons === 'popup' ? '🔲' : '🪟');
    case 'tab':          return n.is_saved ? '·' : '⬤';
    case 'textnote':     return '📝';
    case 'separatorline':return '—';
    case 'group':        return '▸';
    case 'session':      return '🌳';
    default:             return '·';
  }
}

function nodeLabel(n) {
  return n.custom_title || n.title || n.url || n.note_text || `[${n.node_type}]`;
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function highlightText(text, q) {
  if (!q || !text) return escHtml(text ?? '');
  const terms = parseSearchTerms(q).filter(t => !t.field).map(t => t.value);
  if (!terms.length) return escHtml(text);
  let result = escHtml(text);
  for (const term of terms) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    result = result.replace(re, m => `<mark class="search-hl">${m}</mark>`);
  }
  return result;
}

function parseSearchTerms(q) {
  const terms = [];
  const re = /(\w+):(\S+)|(\S+)/g;
  let m;
  while ((m = re.exec(q)) !== null) {
    if (m[1]) terms.push({ field: m[1].toLowerCase(), value: m[2].toLowerCase() });
    else      terms.push({ field: null,                value: m[3].toLowerCase() });
  }
  return terms;
}

function matchesSearch(n, q) {
  const terms = parseSearchTerms(q);
  return terms.every(t => matchesTerm(n, t));
}

function matchesTerm(n, t) {
  const v = t.value;
  const includes = (s) => s && String(s).toLowerCase().includes(v);
  if (!t.field) {
    return includes(n.title) || includes(n.url) || includes(n.note_text) || includes(n.custom_title);
  }
  if (t.field === 'title')  return includes(n.title);
  if (t.field === 'url')    return includes(n.url);
  if (t.field === 'domain') return includes(n.domain);
  if (t.field === 'note')   return includes(n.note_text);
  if (t.field === 'label')  return includes(n.custom_title || n.title || n.url || n.note_text);
  if (t.field === 'tag') {
    const tags = nodeTagsMap[n.id] ?? [];
    return tags.some(tg => tg.name.toLowerCase().includes(v));
  }
  return includes(n.title) || includes(n.url) || includes(n.note_text) || includes(n.custom_title);
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

// ── Build tree HTML ───────────────────────────────────────────────────────────
// searchOpts: { visibleIds: Set, q: string } | null

function buildTree(parentId = null, depth = 0, searchOpts = null) {
  const allChildren = childrenOf(parentId);
  const children    = searchOpts
    ? allChildren.filter(n => searchOpts.visibleIds.has(n.id))
    : allChildren;
  if (!children.length) return '';

  return children.map(n => {
    const allKids = childrenOf(n.id);
    const visKids = searchOpts ? allKids.filter(k => searchOpts.visibleIds.has(k.id)) : allKids;
    const hasKids = visKids.length > 0;
    const isColl  = searchOpts ? false : collapsed.has(n.id);
    const isOpen  = n.is_open === 1;
    const indent  = depth * 16;
    const label   = nodeLabel(n);
    const icon    = nodeIcon(n);
    const isTab   = n.node_type === 'tab';

    const winType = n.node_type === 'win' && n.relicons && n.relicons !== 'normal'
      ? `<span class="badge" style="color:var(--accent);opacity:.7">${escHtml(n.relicons)}</span>` : '';
    const badge   = hasKids ? `<span class="badge">${visKids.length}</span>` : '';
    const toggle  = hasKids
      ? `<span class="toggle">${isColl ? '▶' : '▼'}</span>`
      : `<span class="toggle"></span>`;

    let faviconHtml = '';
    if (n.favicon_url && n.favicon_url.startsWith('http')) {
      faviconHtml = `<img class="favicon" src="${escHtml(n.favicon_url)}" onerror="this.style.display='none'">`;
    }

    const labelHtml = searchOpts ? highlightText(label, searchOpts.q) : escHtml(label);
    const noteText  = n.note_text || '';
    const noteHtml  = searchOpts ? highlightText(noteText, searchOpts.q) : escHtml(noteText);
    const isDup     = n.url && dupUrls.has(n.url);
    const dupIndicator = isDup ? `<span class="dup-dot" title="Duplicate URL"></span>` : '';

    const nodeTags = nodeTagsMap[n.id] ?? [];
    const tagChipsHtml = nodeTags.length
      ? `<span class="tag-chips">${nodeTags.map(t =>
          `<span class="tag-chip" style="background:${escHtml(t.color)}">${escHtml(t.name)}</span>`
        ).join('')}</span>`
      : '';

    const editBtn = `<button class="act act-edit" data-id="${n.id}" title="Edit note">✎</button>`;
    const saveBtn = (n.node_type === 'tab' && !n.is_saved)
      ? `<button class="act act-save" data-id="${n.id}" title="Save &amp; close">💾</button>`
      : (n.node_type === 'win' && !n.is_saved)
        ? `<button class="act act-save-win" data-id="${n.id}" title="Save &amp; close window">💾</button>`
        : '';
    const delBtn  = `<button class="act act-del" data-id="${n.id}" title="Delete">✕</button>`;
    const actions = `<span class="actions">${editBtn}${saveBtn}${delBtn}</span>`;
    const noteRow = `<div class="note-row${noteText ? '' : ' empty'}" data-note-for="${n.id}"
                         style="padding-left:${indent + 20}px">
                      <span class="note-bar">│</span>
                      <span class="note-text">${noteHtml}</span>
                    </div>`;

    const cls = ['node', isOpen && isTab ? 'open-tab' : '', n.id === selected ? 'selected' : '']
      .filter(Boolean).join(' ');

    const kidHtml = hasKids && !isColl ? buildTree(n.id, depth + 1, searchOpts) : '';

    return `<div class="${cls}" data-id="${n.id}" data-type="${n.node_type}"
                 draggable="true"
                 style="padding-left:${indent + 4}px" title="${escHtml(n.url || '')}">
              ${toggle}
              ${dupIndicator}
              ${faviconHtml || `<span class="icon">${icon}</span>`}
              <span class="label-group">
                <span class="label ${label ? '' : 'muted'}">${labelHtml}</span>
                ${tagChipsHtml}
              </span>
              ${winType}${badge}
              ${actions}
            </div>
            ${noteRow}
            ${kidHtml}`;
  }).join('');
}

// ── Render ────────────────────────────────────────────────────────────────────

function render(nodes, filter = '') {
  const treeEl = document.getElementById('tree');
  const searchWinBtn  = document.getElementById('btn-search-window');
  const tagSearchBtn  = document.getElementById('btn-tag-search');
  const saveSearchBtn = document.getElementById('btn-save-search');
  const closeSearchBtn = document.getElementById('btn-close-search');
  if (filter) {
    const q = filter.toLowerCase();

    const matchedIds = new Set(allNodes.filter(n => matchesSearch(n, q)).map(n => n.id));

    const visibleIds = new Set(matchedIds);
    for (const id of matchedIds) {
      let cur = nodeMap[id];
      while (cur?.parent_id != null) {
        if (visibleIds.has(cur.parent_id)) break;
        visibleIds.add(cur.parent_id);
        cur = nodeMap[cur.parent_id];
      }
    }

    const session = allNodes.find(n => n.node_type === 'session');
    treeEl.innerHTML = buildTree(session ? session.id : null, 0, { visibleIds, q });
    setStatus(`${matchedIds.size} result${matchedIds.size !== 1 ? 's' : ''}`);
    searchWinBtn.style.display  = matchedIds.size ? '' : 'none';
    tagSearchBtn.style.display  = matchedIds.size ? '' : 'none';
    saveSearchBtn.style.display = matchedIds.size ? '' : 'none';
    closeSearchBtn.style.display = matchedIds.size ? '' : 'none';
    applyFocusHighlights();
    return;
  }
  searchWinBtn.style.display  = 'none';
  tagSearchBtn.style.display  = 'none';
  saveSearchBtn.style.display = 'none';
  closeSearchBtn.style.display = 'none';
  const session = allNodes.find(n => n.node_type === 'session');
  treeEl.innerHTML = buildTree(session ? session.id : null, 0);
  applyFocusHighlights();
}

// ── Click handler (select + collapse + double-click) ─────────────────────────

document.getElementById('tree').addEventListener('click', e => {
  if (e.target.classList.contains('act')) return;

  const node = e.target.closest('.node');
  if (!node) return;
  const id = +node.dataset.id;
  const n  = nodeMap[id];

  if (e.target.classList.contains('toggle')) {
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    render(allNodes, document.getElementById('search').value);
    return;
  }

  selected = id;
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

document.getElementById('tree').addEventListener('click', async e => {
  const btn = e.target.closest('.act');
  if (!btn) return;
  e.stopPropagation();

  const id = +btn.dataset.id;
  const n  = nodeMap[id];
  if (!n) return;

  if (btn.classList.contains('act-edit')) {
    const noteRow = treeEl.querySelector(`.note-row[data-note-for="${id}"]`);
    if (!noteRow || noteRow.classList.contains('editing')) return;
    const current = nodeMap[id]?.note_text || '';
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
      if (nodeMap[id]) nodeMap[id].note_text = val || null;
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

  if (btn.classList.contains('act-del')) {
    const descIds = allDescendantIds(id);
    if (n.node_type === 'win' && !n.is_saved && n.chrome_id) {
      try { await chrome.windows.remove(n.chrome_id); } catch {}
    } else if (n.chrome_id && n.is_open) {
      try { await chrome.tabs.remove(n.chrome_id); } catch {}
    }
    await db.deleteNode(id);
    allNodes = allNodes.filter(x => !descIds.has(x.id));
    nodeMap  = Object.fromEntries(allNodes.map(x => [x.id, x]));
    recomputeDupUrls();
    render(allNodes, document.getElementById('search').value);
  }
});

// ── Context menu ──────────────────────────────────────────────────────────────

const ctx = document.getElementById('ctx');

document.getElementById('tree').addEventListener('contextmenu', e => {
  e.preventDefault();
  const node = e.target.closest('.node');
  if (!node) return;
  selected = +node.dataset.id;
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
    tagPickerNodeId = null;
  }
});

ctx.addEventListener('click', async e => {
  const action = e.target.dataset.action;
  if (!action || !selected) return;
  const n = nodeMap[selected];

  if (action === 'open' && n?.url) {
    chrome.tabs.create({ url: n.url });
  } else if (action === 'open-all') {
    for (const k of childrenOf(selected)) if (k.url) chrome.tabs.create({ url: k.url });
  } else if (action === 'copy-url' && n?.url) {
    await navigator.clipboard.writeText(n.url);
  } else if (action === 'copy-title') {
    await navigator.clipboard.writeText(nodeLabel(n));
  } else if (action === 'tags') {
    ctx.classList.add('hidden');
    openTagPicker(selected, ctx._lastX, ctx._lastY);
  } else if (action === 'delete') {
    const descIds = allDescendantIds(selected);
    const kidCount = descIds.size - 1;
    const suffix = kidCount > 0 ? ` and ${kidCount} child node${kidCount > 1 ? 's' : ''}` : '';
    if (confirm(`Delete "${nodeLabel(n)}"${suffix}?`)) {
      if (n.node_type === 'win' && !n.is_saved && n.chrome_id) {
        try { await chrome.windows.remove(n.chrome_id); } catch {}
      } else if (n.chrome_id && n.is_open) {
        try { await chrome.tabs.remove(n.chrome_id); } catch {}
      }
      await db.deleteNode(selected);
      allNodes = allNodes.filter(x => !descIds.has(x.id));
      nodeMap  = Object.fromEntries(allNodes.map(x => [x.id, x]));
      recomputeDupUrls();
      render(allNodes, document.getElementById('search').value);
    }
  }
});

// ── Drag & drop ───────────────────────────────────────────────────────────────

const treeEl = document.getElementById('tree');
let dropState = null; // { parentId: number|null }

treeEl.addEventListener('dragstart', e => {
  const node = e.target.closest('.node');
  if (!node) return;
  dragSrcId = +node.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragSrcId));
  setTimeout(() => node.classList.add('dragging'), 0);
});

treeEl.addEventListener('dragend', () => {
  treeEl.querySelectorAll('.dragging, .drag-over').forEach(el => {
    el.classList.remove('dragging', 'drag-over');
  });
  dragSrcId = null;
  dropState = null;
});

treeEl.addEventListener('dragover', e => {
  if (!dragSrcId) return;
  const node = e.target.closest('.node');
  if (!node) return;
  const targetId = +node.dataset.id;
  if (targetId === dragSrcId) return;

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
    let cur = nodeMap[targetId];
    for (let i = 0; i < stepsUp; i++) {
      cur = cur?.parent_id != null ? nodeMap[cur.parent_id] : null;
    }
    parentId = cur?.id ?? null;
  }

  if (parentId != null && allDescendantIds(dragSrcId).has(parentId)) return;

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
  if (!dragSrcId || !dropState) return;
  treeEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  const { parentId } = dropState;
  dropState = null;
  const pos = childrenOf(parentId).length;
  await db.moveNode(dragSrcId, parentId, pos);
  dragSrcId = null;
  load();
});

// ── Search ────────────────────────────────────────────────────────────────────

let searchTimer = null;
document.getElementById('search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => render(allNodes, e.target.value.trim()), 200);
});

// ── Toolbar buttons ───────────────────────────────────────────────────────────

document.getElementById('btn-refresh').addEventListener('click', async () => {
  await db.resync();
  await syncFocusState();
  await load();
});

// ── Live updates ──────────────────────────────────────────────────────────────

let liveTimer = null;
function scheduleRefresh() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(load, 600);
}

chrome.tabs.onCreated.addListener(scheduleRefresh);
chrome.tabs.onRemoved.addListener(scheduleRefresh);
chrome.tabs.onUpdated.addListener(scheduleRefresh);
chrome.windows.onCreated.addListener(scheduleRefresh);
chrome.windows.onRemoved.addListener(scheduleRefresh);

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  for (const chromeId of [...focusState.activeTabChromeIds]) {
    const node = allNodes.find(n => n.chrome_id === chromeId);
    if (node) {
      const parentWin = nodeMap[node.parent_id];
      if (parentWin && parentWin.chrome_id === windowId) {
        focusState.activeTabChromeIds.delete(chromeId);
      }
    }
  }
  focusState.activeTabChromeIds.add(tabId);
  applyFocusHighlights();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  focusState.focusedWinChromeId = windowId > 0 ? windowId : null;
  applyFocusHighlights();
});

// ── SQL panel ─────────────────────────────────────────────────────────────────

const sqlQuickEl = document.getElementById('sql-quick');
let sqlLastRows  = [];

async function loadQuickQueries() {
  const r    = await db.send('get_quick_queries');
  const rows = r?.rows ?? [];
  sqlQuickEl.innerHTML = '<option value="">Saved queries…</option>';
  rows.forEach(q => {
    const opt = document.createElement('option');
    opt.value        = q.id;
    opt.textContent  = q.label;
    opt.dataset.sql  = q.sql;
    opt.dataset.def  = q.is_default;
    sqlQuickEl.appendChild(opt);
  });
}

async function runSQL(sql) {
  const statusEl  = document.getElementById('sql-status');
  const resultsEl = document.getElementById('sql-results');
  statusEl.textContent = 'Running…';
  const t0 = Date.now();
  try {
    const r    = await db.query(sql);
    const rows = r?.rows ?? [];
    const elapsed = Date.now() - t0;
    sqlLastRows = rows;
    renderSqlTable(rows);
    statusEl.textContent = `${rows.length} row${rows.length !== 1 ? 's' : ''} · ${elapsed}ms`;
    if (!/^\s*SELECT/i.test(sql)) load();
  } catch(e) {
    resultsEl.innerHTML = `<div style="color:var(--red);padding:8px;font-size:12px">Error: ${escHtml(e.message)}</div>`;
    statusEl.textContent = 'Error';
    sqlLastRows = [];
  }
}

function renderSqlTable(rows) {
  const el = document.getElementById('sql-results');
  if (!rows.length) {
    el.innerHTML = '<div style="padding:8px;color:var(--muted);font-size:12px">No rows returned.</div>';
    return;
  }
  const cols   = Object.keys(rows[0]);
  const header = `<tr>${cols.map(c => `<th>${escHtml(c)}</th>`).join('')}</tr>`;
  const body   = rows.map(row =>
    `<tr>${cols.map(c => {
      const v = row[c];
      return (v === null || v === undefined)
        ? `<td class="sql-null">NULL</td>`
        : `<td title="${escHtml(String(v))}">${escHtml(String(v))}</td>`;
    }).join('')}</tr>`
  ).join('');
  el.innerHTML = `<table><thead>${header}</thead><tbody>${body}</tbody></table>`;
}


// ── Quick-query select ────────────────────────────────────────────────────────

sqlQuickEl.addEventListener('change', () => {
  const opt = sqlQuickEl.options[sqlQuickEl.selectedIndex];
  if (!opt?.dataset.sql) return;
  document.getElementById('sql-input').value = opt.dataset.sql;
  runSQL(opt.dataset.sql);
});

// ── Save current query ────────────────────────────────────────────────────────

document.getElementById('sql-save-query').addEventListener('click', async () => {
  const sql = document.getElementById('sql-input').value.trim();
  if (!sql) return;

  const selOpt = sqlQuickEl.options[sqlQuickEl.selectedIndex];
  const selId  = selOpt?.value ? +selOpt.value : null;
  const selLabel = selOpt?.textContent ?? '';

  let label, id;
  if (selId) {
    label = prompt(`Update "${selLabel}" or enter a new name to save a copy:`, selLabel);
    if (label === null) return;
    id = (label.trim() === selLabel) ? selId : null;
    label = label.trim() || selLabel;
  } else {
    label = prompt('Query name:', '');
    if (!label?.trim()) return;
    id = null;
  }

  await db.send('save_quick_query', { id, label: label.trim(), sql });
  await loadQuickQueries();
  for (const opt of sqlQuickEl.options) {
    if (opt.dataset.sql === sql && opt.textContent === label.trim()) {
      sqlQuickEl.value = opt.value;
      break;
    }
  }
  document.getElementById('sql-status').textContent = id ? 'Updated.' : 'Saved.';
});

// ── Delete selected query ─────────────────────────────────────────────────────

document.getElementById('sql-del-query').addEventListener('click', async () => {
  const id = +sqlQuickEl.value;
  if (!id) return;
  await db.send('delete_quick_query', { id });
  await loadQuickQueries();
  document.getElementById('sql-status').textContent = 'Deleted.';
});

// ── Restore defaults ──────────────────────────────────────────────────────────

document.getElementById('sql-restore-defaults').addEventListener('click', async () => {
  const r = await db.send('seed_default_queries');
  await loadQuickQueries();
  const added = r?.added ?? 0;
  document.getElementById('sql-status').textContent =
    added > 0 ? `${added} default${added > 1 ? 's' : ''} restored.` : 'All defaults already present.';
});

// ── Run / keyboard ────────────────────────────────────────────────────────────

document.getElementById('sql-run').addEventListener('click', () => {
  const sql = document.getElementById('sql-input').value.trim();
  if (sql) runSQL(sql);
});

document.getElementById('sql-input').addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') {
    const sql = e.target.value.trim();
    if (sql) runSQL(sql);
  }
});


// ── SQL panel resize ──────────────────────────────────────────────────────────

const sqlResizeEl = document.getElementById('sql-resize');
const sqlPanelEl  = document.getElementById('sql-panel');
const mainEl      = document.getElementById('main');
let resizing      = false;
let resizeStartY  = 0;
let resizeStartH  = 0;

sqlResizeEl.addEventListener('mousedown', e => {
  resizing     = true;
  resizeStartY = e.clientY;
  resizeStartH = sqlPanelEl.getBoundingClientRect().height;
  sqlResizeEl.classList.add('dragging');
  e.preventDefault();
});

document.addEventListener('mousemove', e => {
  if (!resizing) return;
  const delta = resizeStartY - e.clientY;
  const newH  = Math.max(60, Math.min(resizeStartH + delta, mainEl.clientHeight - 60));
  sqlPanelEl.style.height = newH + 'px';
});

document.addEventListener('mouseup', () => {
  if (!resizing) return;
  resizing = false;
  sqlResizeEl.classList.remove('dragging');
});

// ── Config panel ──────────────────────────────────────────────────────────────

const COLOR_VARS = [
  { prop: '--bg',        label: 'Background',     def: '#1e1e2e' },
  { prop: '--surface',   label: 'Surface',        def: '#2a2a3e' },
  { prop: '--border',    label: 'Border',         def: '#3a3a5a' },
  { prop: '--accent',    label: 'Accent',         def: '#7c9ef8' },
  { prop: '--text',      label: 'Text',           def: '#cdd6f4' },
  { prop: '--muted',     label: 'Muted text',     def: '#6e6e8e' },
  { prop: '--hover',     label: 'Row hover',      def: '#313145' },
  { prop: '--win-icon',  label: 'Window icon',    def: '#f9c74f' },
  { prop: '--tab-icon',  label: 'Tab icon',       def: '#90e0ef' },
  { prop: '--note-icon', label: 'Note icon',      def: '#a8dadc' },
  { prop: '--search-hl', label: 'Search highlight', def: '#5a4a00' },
  { prop: '--dup-url',   label: 'Duplicate URL',  def: '#f38ba8' },
  { prop: '--focus-bg',  label: 'Focus highlight', def: '#1a3a5c' },
];

const THEME_KEY = 'tabsql_theme';

async function loadTheme() {
  const stored = await chrome.storage.local.get(THEME_KEY);
  const theme  = stored[THEME_KEY] ?? {};
  COLOR_VARS.forEach(cv => {
    document.documentElement.style.setProperty(cv.prop, theme[cv.prop] ?? cv.def);
  });
  return theme;
}

function buildColorGrid(theme) {
  const grid = document.getElementById('cfg-colors-grid');
  grid.innerHTML = '';
  COLOR_VARS.forEach(cv => {
    const val = theme[cv.prop] ?? cv.def;
    const row = document.createElement('div');
    row.className = 'cfg-color-row';
    row.innerHTML = `<label>${cv.label}</label><input type="color" data-prop="${cv.prop}" value="${val}">`;
    grid.appendChild(row);
  });
  grid.querySelectorAll('input[type=color]').forEach(inp => {
    inp.addEventListener('input', async () => {
      document.documentElement.style.setProperty(inp.dataset.prop, inp.value);
      const stored = await chrome.storage.local.get(THEME_KEY);
      const t = stored[THEME_KEY] ?? {};
      t[inp.dataset.prop] = inp.value;
      await chrome.storage.local.set({ [THEME_KEY]: t });
    });
  });
}

document.getElementById('btn-config').addEventListener('click', () => {
  document.getElementById('config-panel').classList.toggle('hidden');
});

document.getElementById('cfg-colors-reset').addEventListener('click', async () => {
  await chrome.storage.local.remove(THEME_KEY);
  COLOR_VARS.forEach(cv => document.documentElement.style.setProperty(cv.prop, cv.def));
  buildColorGrid({});
});

// ── Import / Export ───────────────────────────────────────────────────────────

const TO_NODE_INSERT = 2001;
const TO_EOF_OP      = 11111;

function cfgStatus(msg) {
  document.getElementById('cfg-io-status').textContent = msg;
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('cfg-import').addEventListener('click', () => {
  document.getElementById('cfg-file-input').click();
});

document.getElementById('cfg-file-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const fmt  = document.getElementById('cfg-format').value;
  cfgStatus('Importing…');
  try {
    if (fmt === 'taboutliner') await importTabOutliner(text);
    else                       await importSQL(text);
    await load();
    cfgStatus('Import complete.');
  } catch (err) {
    cfgStatus('Error: ' + err.message);
    console.error(err);
  }
  e.target.value = '';
});

document.getElementById('cfg-export').addEventListener('click', async () => {
  const fmt = document.getElementById('cfg-format').value;
  cfgStatus('Exporting…');
  try {
    if (fmt === 'taboutliner') await exportTabOutliner();
    else                       await exportSQL();
    cfgStatus('Export complete.');
  } catch (err) {
    cfgStatus('Error: ' + err.message);
    console.error(err);
  }
});

// ── TabOutliner import ────────────────────────────────────────────────────────

function parseTabOutlinerNode(raw) {
  let ntype = raw.type ?? 'tab';
  let is_saved = 0;
  if (ntype === 'savedtab') { ntype = 'tab'; is_saved = 1; }
  else if (ntype === 'savedwin') { ntype = 'win'; is_saved = 1; }
  const marks  = raw.marks ?? {};
  const data   = raw.data  ?? {};
  return {
    node_type:      ntype,
    is_saved,
    is_collapsed:   raw.colapsed ? 1 : 0,
    is_open:        (ntype === 'win' || ntype === 'tab') && !is_saved ? 1 : 0,
    title:          data.title        ?? null,
    url:            data.url          ?? null,
    favicon_url:    data.favIconUrl   ?? null,
    note_text:      data.note         ?? null,
    custom_title:   marks.customTitle       ?? null,
    custom_favicon: marks.customFavicon     ?? null,
    color_active:   marks.customColorActive ?? null,
    color_saved:    marks.customColorSaved  ?? null,
    relicons:       marks.relicons ? JSON.stringify(marks.relicons) : null,
    win_rect:       data.rect ?? null,
    chrome_id:      null,
  };
}

async function importTabOutliner(text) {
  const raw = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error('Expected a JSON array');

  const pathToId   = {};
  const posCounter = {};

  for (const item of raw) {
    if (!Array.isArray(item)) continue;
    if (item[0] !== TO_NODE_INSERT) continue;
    if (item.length < 3) continue;

    const path      = item[2];
    const pathKey   = path.join(',');
    const parentKey = path.slice(0, -1).join(',');

    if (posCounter[parentKey] === undefined) posCounter[parentKey] = 0;

    const node = parseTabOutlinerNode(item[1]);
    node.parent_id = pathToId[parentKey] ?? null;
    node.position  = posCounter[parentKey]++;

    const cleaned = Object.fromEntries(Object.entries(node).filter(([, v]) => v != null));
    const result  = await db.send('upsert_node', { node: cleaned });
    pathToId[pathKey] = result?.id;
  }
}

// ── TabOutliner export ────────────────────────────────────────────────────────

async function exportTabOutliner() {
  const r     = await db.query('SELECT * FROM node ORDER BY parent_id NULLS FIRST, position');
  const nodes = r?.rows ?? [];

  function toToNode(n) {
    const marks = {};
    if (n.custom_title)   marks.customTitle        = n.custom_title;
    if (n.custom_favicon) marks.customFavicon      = n.custom_favicon;
    if (n.color_active)   marks.customColorActive  = n.color_active;
    if (n.color_saved)    marks.customColorSaved   = n.color_saved;
    if (n.relicons) { try { marks.relicons = JSON.parse(n.relicons); } catch {} }
    const data = {};
    if (n.title)       data.title      = n.title;
    if (n.url)         data.url        = n.url;
    if (n.favicon_url) data.favIconUrl = n.favicon_url;
    if (n.note_text)   data.note       = n.note_text;
    if (n.win_rect)    data.rect       = n.win_rect;
    // Map back to TabOutliner type names for compatibility
    const exportType = (n.node_type === 'win' && n.is_saved) ? 'savedwin'
                     : (n.node_type === 'tab' && n.is_saved) ? 'savedtab'
                     : n.node_type;
    return { type: exportType, colapsed: !!n.is_collapsed, data, marks };
  }

  const result = [{ type: 'TREE_CREATE', treeStorage: 'TabSQL export' }];

  function traverse(parentId, pathSoFar) {
    nodes.filter(n => n.parent_id == parentId)
         .sort((a, b) => a.position - b.position)
         .forEach((n, i) => {
           const path = [...pathSoFar, i];
           result.push([TO_NODE_INSERT, toToNode(n), path]);
           traverse(n.id, path);
         });
  }

  const session = nodes.find(n => n.node_type === 'session');
  traverse(session ? session.id : null, []);
  result.push([TO_EOF_OP]);

  downloadFile('tabsql-export.tree', JSON.stringify(result, null, 2), 'application/json');
}

// ── SQL import ────────────────────────────────────────────────────────────────

async function importSQL(text) {
  const stripped   = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const statements = stripped.split(';').map(s => s.trim()).filter(Boolean);
  for (const sql of statements) {
    await db.send('exec_raw', { sql });
  }
}

// ── SQL export ────────────────────────────────────────────────────────────────

const SQL_DDL_COMMENT = `/*
CREATE TABLE IF NOT EXISTS node (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id      INTEGER REFERENCES node(id),
  node_type      TEXT    NOT NULL,
  position       INTEGER NOT NULL DEFAULT 0,
  is_collapsed   INTEGER NOT NULL DEFAULT 0,
  is_open        INTEGER NOT NULL DEFAULT 0,
  is_saved       INTEGER NOT NULL DEFAULT 0,
  chrome_id      INTEGER DEFAULT NULL,
  title          TEXT,
  url            TEXT,
  favicon_url    TEXT,
  note_text      TEXT,
  custom_title   TEXT,
  custom_favicon TEXT,
  color_active   TEXT,
  color_saved    TEXT,
  relicons       TEXT,
  win_rect       TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
*/`;

async function exportSQL() {
  const r     = await db.query('SELECT * FROM node ORDER BY id');
  const nodes = r?.rows ?? [];

  const cols = ['id','parent_id','node_type','position','is_collapsed','is_open','is_saved',
                'chrome_id','title','url','favicon_url','note_text','custom_title',
                'custom_favicon','color_active','color_saved','relicons','win_rect',
                'created_at','updated_at'];

  function sqlVal(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  }

  const inserts = nodes.map(n =>
    `INSERT OR REPLACE INTO node (${cols.join(', ')}) VALUES (${cols.map(c => sqlVal(n[c])).join(', ')});`
  );

  downloadFile('tabsql-export.sql', [SQL_DDL_COMMENT, '', ...inserts].join('\n'), 'text/plain');
}

// ── Tag picker ────────────────────────────────────────────────────────────────

const tagPickerEl     = document.getElementById('tag-picker');
const tagPickerListEl = document.getElementById('tag-picker-list');

async function openTagPicker(nodeId, x, y) {
  tagPickerNodeId = nodeId;
  const n = nodeMap[nodeId];
  const isWin = n?.node_type === 'win';

  const r = await db.send('get_node_tags', { nodeId });
  const currentTagIds = new Set((r?.rows ?? []).map(t => t.id));

  let autoTagIds = new Set();
  if (isWin) {
    const ar = await db.send('get_win_auto_tags', { winNodeId: nodeId });
    autoTagIds = new Set((ar?.rows ?? []).map(t => t.id));
  }

  renderTagPickerList(nodeId, currentTagIds, autoTagIds, isWin);

  tagPickerEl.style.left = Math.min(x, window.innerWidth - 220) + 'px';
  tagPickerEl.style.top  = Math.min(y, window.innerHeight - 300) + 'px';
  tagPickerEl.classList.remove('hidden');
}

function renderTagPickerList(nodeId, currentTagIds, autoTagIds, isWin) {
  tagPickerListEl.innerHTML = allTags.map(t => `
    <div class="tag-pick-row" data-tag-id="${t.id}">
      <span class="tag-pick-dot" style="background:${escHtml(t.color)}"></span>
      <span class="tag-pick-name">${escHtml(t.name)}</span>
      <span class="tag-pick-check">${currentTagIds.has(t.id) ? '✓' : ''}</span>
    </div>
  `).join('') || '<div style="padding:4px 6px;font-size:11px;color:var(--muted)">No tags yet</div>';

  const autoSection = document.getElementById('tag-picker-win-auto');
  if (isWin) {
    autoSection.classList.remove('hidden');
  } else {
    autoSection.classList.add('hidden');
  }

  tagPickerListEl.querySelectorAll('.tag-pick-row').forEach(row => {
    row.addEventListener('click', async e => {
      e.stopPropagation();
      const tagId = +row.dataset.tagId;
      const wasOn = currentTagIds.has(tagId);
      if (wasOn) currentTagIds.delete(tagId); else currentTagIds.add(tagId);
      await db.send('set_node_tags', { nodeId: tagPickerNodeId, tagIds: [...currentTagIds] });
      nodeTagsMap[tagPickerNodeId] = allTags.filter(t => currentTagIds.has(t.id));
      const nodeEl = treeEl.querySelector(`[data-id="${tagPickerNodeId}"]`);
      if (nodeEl) {
        let chips = nodeEl.querySelector('.tag-chips');
        const tags = nodeTagsMap[tagPickerNodeId] ?? [];
        if (!chips) {
          chips = document.createElement('span');
          chips.className = 'tag-chips';
          const labelGroup = nodeEl.querySelector('.label-group');
          if (labelGroup) {
            labelGroup.appendChild(chips);
          } else {
            nodeEl.querySelector('.label').after(chips);
          }
        }
        chips.innerHTML = tags.map(t =>
          `<span class="tag-chip" style="background:${escHtml(t.color)}">${escHtml(t.name)}</span>`
        ).join('');
      }
      renderTagPickerList(tagPickerNodeId, currentTagIds, autoTagIds, isWin);
    });
  });

  if (isWin) {
    const cb = document.getElementById('tag-picker-auto-cb');
    cb.checked = [...currentTagIds].some(tid => autoTagIds.has(tid));
    cb.onchange = async () => {
      for (const tid of currentTagIds) {
        await db.send('set_win_auto_tag', { winNodeId: tagPickerNodeId, tagId: tid, enabled: cb.checked });
        if (cb.checked) autoTagIds.add(tid); else autoTagIds.delete(tid);
      }
    };
  }
}

// Add new tag from picker
document.getElementById('tag-picker-new-add').addEventListener('click', async e => {
  e.stopPropagation();
  const name  = document.getElementById('tag-picker-new-name').value.trim();
  const color = document.getElementById('tag-picker-new-color').value;
  if (!name) return;
  await db.send('save_tag', { name, color });
  await loadTags();
  document.getElementById('tag-picker-new-name').value = '';
  if (tagPickerNodeId != null) {
    const cr = await db.send('get_node_tags', { nodeId: tagPickerNodeId });
    const currentTagIds = new Set((cr?.rows ?? []).map(t => t.id));
    const n = nodeMap[tagPickerNodeId];
    const isWin = n?.node_type === 'win';
    renderTagPickerList(tagPickerNodeId, currentTagIds, new Set(), isWin);
  }
});

document.getElementById('tag-picker-new-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('tag-picker-new-add').click();
  e.stopPropagation();
});

// ── Search toolbar buttons ────────────────────────────────────────────────────

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

document.getElementById('btn-tag-search').addEventListener('click', async e => {
  e.stopPropagation();
  if (!allTags.length) {
    setStatus('No tags defined yet — create one in Settings > Tags');
    return;
  }
  const q = document.getElementById('search').value.trim();
  const btn = document.getElementById('btn-tag-search');
  const rect = btn.getBoundingClientRect();
  tagPickerNodeId = null;

  const picker = document.getElementById('tag-picker');
  const autoSection = document.getElementById('tag-picker-win-auto');
  autoSection.classList.add('hidden');

  tagPickerListEl.innerHTML = allTags.map(t => `
    <div class="tag-pick-row" data-tag-id="${t.id}">
      <span class="tag-pick-dot" style="background:${escHtml(t.color)}"></span>
      <span class="tag-pick-name">${escHtml(t.name)}</span>
      <span class="tag-pick-check"></span>
    </div>
  `).join('');

  tagPickerListEl.querySelectorAll('.tag-pick-row').forEach(row => {
    row.addEventListener('click', async ev => {
      ev.stopPropagation();
      picker.classList.add('hidden');
      const tagId = +row.dataset.tagId;
      const r2 = await db.send('tag_search_results', { q, tagId });
      await load();
      setStatus(`Tagged ${r2?.count ?? 0} nodes`);
    });
  });

  picker.style.left = rect.left + 'px';
  picker.style.top  = (rect.bottom + 4) + 'px';
  picker.classList.remove('hidden');
});

// ── Config: Tags ──────────────────────────────────────────────────────────────

async function loadCfgTags() {
  const r    = await db.send('get_tags');
  allTags    = r?.rows ?? [];
  const list = document.getElementById('cfg-tag-list');
  list.innerHTML = allTags.map(t => `
    <div class="tag-list-row">
      <span class="tag-list-dot" style="background:${escHtml(t.color)}"></span>
      <span class="tag-list-name">${escHtml(t.name)}</span>
      <button class="tag-list-del" data-id="${t.id}" title="Delete tag">✕</button>
    </div>
  `).join('') || '<div style="font-size:11px;color:var(--muted)">No tags yet</div>';

  list.querySelectorAll('.tag-list-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      await db.send('delete_tag', { id: +btn.dataset.id });
      await loadCfgTags();
      await load();
    });
  });
}

document.getElementById('cfg-tag-add').addEventListener('click', async () => {
  const name  = document.getElementById('cfg-tag-name').value.trim();
  const color = document.getElementById('cfg-tag-color').value;
  if (!name) return;
  await db.send('save_tag', { name, color });
  document.getElementById('cfg-tag-name').value = '';
  await loadCfgTags();
});

document.getElementById('cfg-tag-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('cfg-tag-add').click();
});

// ── Config: Actions ───────────────────────────────────────────────────────────

async function loadCfgActions() {
  const [ar, tr] = await Promise.all([db.send('get_action_rules'), db.send('get_tags')]);
  allTags = tr?.rows ?? [];
  const rules = ar?.rows ?? [];
  const list  = document.getElementById('cfg-action-list');

  if (!rules.length) {
    list.innerHTML = '<div style="font-size:11px;color:var(--muted)">No actions yet</div>';
    return;
  }

  list.innerHTML = rules.map(r => {
    const cfg = r.config ? JSON.parse(r.config) : {};
    const tagName = cfg.tag_id ? (allTags.find(t => t.id === cfg.tag_id)?.name ?? '?') : '';
    const badgeText = r.action_type === 'add_tag'      ? `tag:${tagName}`
                    : r.action_type === 'delete'       ? `delete${cfg.delay_days ? ` (${cfg.delay_days}d)` : ''}`
                    : r.action_type === 'move'         ? 'move'
                    : r.action_type === 'save_on_close' ? 'save-on-close'
                    : r.action_type;
    return `
      <div class="action-row" data-rule-id="${r.id}">
        <div class="action-row-hdr">
          <span class="action-name">${escHtml(r.name)}</span>
          <span class="action-badges">
            <span class="action-badge">${escHtml(badgeText)}</span>
            ${r.is_auto ? '<span class="action-badge auto">auto</span>' : ''}
          </span>
          <span class="action-row-btns">
            <button class="ar-run" data-id="${r.id}" title="Run now">▶</button>
            <button class="ar-edit" data-id="${r.id}" title="Edit">✎</button>
            <button class="ar-del" data-id="${r.id}" title="Delete">✕</button>
          </span>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.ar-run').forEach(btn => {
    btn.addEventListener('click', async () => {
      const status = document.getElementById('cfg-actions-status');
      status.textContent = 'Running…';
      const r2 = await db.send('run_action_rule', { id: +btn.dataset.id });
      status.textContent = `${r2?.affected ?? 0} affected`;
      await load();
    });
  });

  list.querySelectorAll('.ar-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      await db.send('delete_action_rule', { id: +btn.dataset.id });
      await loadCfgActions();
    });
  });

  list.querySelectorAll('.ar-edit').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ruleId = +btn.dataset.id;
      const rule = rules.find(r => r.id === ruleId);
      if (!rule) return;
      showActionEditor(rule);
    });
  });
}

function showActionEditor(existing) {
  const list   = document.getElementById('cfg-action-list');
  const cfg    = existing?.config ? JSON.parse(existing.config) : {};
  const tagOpts = allTags.map(t => `<option value="${t.id}" ${cfg.tag_id === t.id ? 'selected' : ''}>${escHtml(t.name)}</option>`).join('');

  const editorHtml = `
    <div class="action-editor" id="action-editor-form">
      <div class="action-editor-row">
        <label>Name</label>
        <input type="text" id="ae-name" value="${escHtml(existing?.name ?? '')}" placeholder="Action name">
      </div>
      <div class="action-editor-row">
        <label>Type</label>
        <select id="ae-type">
          <option value="add_tag"      ${existing?.action_type === 'add_tag'      ? 'selected' : ''}>Add tag</option>
          <option value="delete"       ${existing?.action_type === 'delete'       ? 'selected' : ''}>Delete</option>
          <option value="move"         ${existing?.action_type === 'move'         ? 'selected' : ''}>Move to window</option>
          <option value="save_on_close" ${existing?.action_type === 'save_on_close' ? 'selected' : ''}>Save on close</option>
        </select>
      </div>
      <div class="action-editor-row" id="ae-tag-row">
        <label>Tag</label>
        <select id="ae-tag">${tagOpts}</select>
      </div>
      <div class="action-editor-row" id="ae-delay-row">
        <label>Delay (days, 0=immediate)</label>
        <input type="number" id="ae-delay" value="${cfg.delay_days ?? 0}" min="0">
      </div>
      <div class="action-editor-row" id="ae-win-row">
        <label>Target window node ID</label>
        <input type="number" id="ae-win" value="${cfg.target_win_id ?? ''}">
      </div>
      <div class="action-editor-row">
        <label>Condition type</label>
        <select id="ae-cond-type">
          <option value="search" ${existing?.condition_type !== 'sql' ? 'selected' : ''}>Search string</option>
          <option value="sql"    ${existing?.condition_type === 'sql'  ? 'selected' : ''}>SQL query</option>
        </select>
      </div>
      <div>
        <label>Condition</label>
        <textarea id="ae-condition" placeholder="Search terms or SQL SELECT…">${escHtml(existing?.condition ?? '')}</textarea>
      </div>
      <div class="action-editor-row">
        <label><input type="checkbox" id="ae-auto" ${existing?.is_auto ? 'checked' : ''}> Run automatically</label>
      </div>
      <div class="action-editor-row">
        <button class="btn" id="ae-save">Save</button>
        <button class="btn" id="ae-cancel">Cancel</button>
      </div>
    </div>`;

  const container = document.createElement('div');
  container.innerHTML = editorHtml;
  list.prepend(container);

  function updateVisibility() {
    const type = document.getElementById('ae-type').value;
    document.getElementById('ae-tag-row').style.display   = type === 'add_tag'      ? '' : 'none';
    document.getElementById('ae-delay-row').style.display = type === 'delete'        ? '' : 'none';
    document.getElementById('ae-win-row').style.display   = type === 'move'          ? '' : 'none';
  }
  updateVisibility();
  document.getElementById('ae-type').addEventListener('change', updateVisibility);

  document.getElementById('ae-cancel').addEventListener('click', () => {
    container.remove();
  });

  document.getElementById('ae-save').addEventListener('click', async () => {
    const name      = document.getElementById('ae-name').value.trim();
    const type      = document.getElementById('ae-type').value;
    const condType  = document.getElementById('ae-cond-type').value;
    const condition = document.getElementById('ae-condition').value.trim();
    const isAuto    = document.getElementById('ae-auto').checked;
    if (!name || !condition) return;
    const cfgObj = {};
    if (type === 'add_tag') cfgObj.tag_id = +document.getElementById('ae-tag').value;
    if (type === 'delete')  cfgObj.delay_days = +document.getElementById('ae-delay').value;
    if (type === 'move')    cfgObj.target_win_id = +document.getElementById('ae-win').value;
    await db.send('save_action_rule', {
      id: existing?.id,
      name, action_type: type, condition_type: condType, condition,
      config: JSON.stringify(cfgObj), is_auto: isAuto,
    });
    container.remove();
    await loadCfgActions();
  });
}

document.getElementById('cfg-action-new').addEventListener('click', () => showActionEditor(null));

document.getElementById('cfg-action-run-all').addEventListener('click', async () => {
  const status = document.getElementById('cfg-actions-status');
  status.textContent = 'Running…';
  const r = await db.send('run_auto_actions');
  status.textContent = `${r?.total ?? 0} affected`;
  await load();
});

// Reload tags/actions sections when their config header is expanded
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

// ── Schema popup ──────────────────────────────────────────────────────────────

document.getElementById('sql-schema').addEventListener('click', async () => {
  const popup = document.getElementById('schema-popup');
  popup.classList.remove('hidden');
  const body = document.getElementById('schema-popup-body');
  body.innerHTML = '<div style="padding:16px;color:var(--muted)">Loading…</div>';
  try {
    const r = await db.send('get_schema');
    const schema = r?.schema ?? {};
    body.innerHTML = Object.entries(schema).map(([tname, cols]) => `
      <div class="schema-table">
        <div class="schema-table-name">${escHtml(tname)}</div>
        <table class="schema-cols">
          <thead><tr><th>col</th><th>type</th><th>notnull</th><th>default</th></tr></thead>
          <tbody>${(cols ?? []).map(c => `<tr>
            <td>${c.pk ? `<span class="schema-pk">PK </span>` : ''}${escHtml(c.name)}</td>
            <td>${escHtml(c.type)}</td>
            <td>${c.notnull ? '✓' : ''}</td>
            <td>${c.dflt_value != null ? escHtml(String(c.dflt_value)) : ''}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    `).join('');
  } catch(e) {
    body.innerHTML = `<div style="padding:16px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
});

document.getElementById('schema-popup-close').addEventListener('click', () => {
  document.getElementById('schema-popup').classList.add('hidden');
});

// ── Boot ──────────────────────────────────────────────────────────────────────

load();
loadQuickQueries().then(() => {
  const first = sqlQuickEl.options[1];
  if (first?.dataset.sql) {
    document.getElementById('sql-input').value = first.dataset.sql;
    runSQL(first.dataset.sql);
  }
});
loadTheme().then(theme => buildColorGrid(theme));
