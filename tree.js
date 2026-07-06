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
};

// ── State ─────────────────────────────────────────────────────────────────────

let allNodes = [];
let nodeMap  = {};
let collapsed = new Set();
let selected  = null;
let dragSrcId = null;

// ── Load ──────────────────────────────────────────────────────────────────────

async function load() {
  setStatus('Loading…');
  try {
    const all = await db.query('SELECT * FROM node ORDER BY parent_id NULLS FIRST, position');
    allNodes = all?.rows ?? [];
    nodeMap  = Object.fromEntries(allNodes.map(n => [n.id, n]));
    render(allNodes);
    setStatus(`${allNodes.length} nodes`);
  } catch(e) {
    setStatus('Error: ' + e.message);
    console.error(e);
  }
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

function nodeIcon(n) {
  switch(n.node_type) {
    case 'win':          return n.relicons === 'popup' ? '🔲' : '🪟';
    case 'savedwin':     return '📁';
    case 'tab':          return '⬤';
    case 'savedtab':     return '·';
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

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

// ── Build tree HTML ───────────────────────────────────────────────────────────

function buildTree(parentId = null, depth = 0) {
  const children = childrenOf(parentId);
  if (!children.length) return '';

  return children.map(n => {
    const kids    = childrenOf(n.id);
    const hasKids = kids.length > 0;
    const isColl  = collapsed.has(n.id);
    const isOpen  = n.is_open === 1;
    const indent  = depth * 16;
    const label   = nodeLabel(n);
    const icon    = nodeIcon(n);
    const isTab   = n.node_type === 'tab' || n.node_type === 'savedtab';

    const winType = (n.node_type === 'win' || n.node_type === 'savedwin') && n.relicons && n.relicons !== 'normal'
      ? `<span class="badge" style="color:var(--accent);opacity:.7">${escHtml(n.relicons)}</span>` : '';
    const badge   = hasKids ? `<span class="badge">${kids.length}</span>` : '';
    const toggle  = hasKids
      ? `<span class="toggle">${isColl ? '▶' : '▼'}</span>`
      : `<span class="toggle"></span>`;

    let faviconHtml = '';
    if (n.favicon_url && n.favicon_url.startsWith('http')) {
      faviconHtml = `<img class="favicon" src="${escHtml(n.favicon_url)}" onerror="this.style.display='none'">`;
    }

    const editBtn  = `<button class="act act-edit" data-id="${n.id}" title="Edit note">✎</button>`;
    const saveBtn  = (n.node_type === 'tab')
      ? `<button class="act act-save" data-id="${n.id}" title="Save &amp; close">💾</button>`
      : '';
    const delBtn   = `<button class="act act-del" data-id="${n.id}" title="Delete">✕</button>`;
    const actions  = `<span class="actions">${editBtn}${saveBtn}${delBtn}</span>`;
    const noteRow  = `<div class="note-row${n.note_text ? '' : ' empty'}" data-note-for="${n.id}"
                          style="padding-left:${indent + 20}px">
                       <span class="note-bar">│</span>
                       <span class="note-text">${escHtml(n.note_text || '')}</span>
                     </div>`;

    const cls = ['node', isOpen && isTab ? 'open-tab' : '', n.id === selected ? 'selected' : '']
      .filter(Boolean).join(' ');

    const kidHtml = hasKids && !isColl ? buildTree(n.id, depth + 1) : '';

    return `<div class="${cls}" data-id="${n.id}" data-type="${n.node_type}"
                 draggable="true"
                 style="padding-left:${indent + 4}px" title="${escHtml(n.url || '')}">
              ${toggle}
              ${faviconHtml || `<span class="icon">${icon}</span>`}
              <span class="label ${label ? '' : 'muted'}">${escHtml(label)}</span>
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
  if (filter) {
    const q = filter.toLowerCase();
    const matched = allNodes.filter(n =>
      (n.title||'').toLowerCase().includes(q) ||
      (n.url||'').toLowerCase().includes(q) ||
      (n.note_text||'').toLowerCase().includes(q) ||
      (n.custom_title||'').toLowerCase().includes(q)
    );
    treeEl.innerHTML = matched.map(n => {
      const label   = nodeLabel(n);
      const editBtn = `<button class="act act-edit" data-id="${n.id}" title="Edit note">✎</button>`;
      const saveBtn = n.node_type === 'tab'
        ? `<button class="act act-save" data-id="${n.id}" title="Save &amp; close">💾</button>` : '';
      const noteRow = `<div class="note-row${n.note_text ? '' : ' empty'}" data-note-for="${n.id}"
                            style="padding-left:20px">
                         <span class="note-bar">│</span>
                         <span class="note-text">${escHtml(n.note_text || '')}</span>
                       </div>`;
      return `<div class="node" data-id="${n.id}" data-type="${n.node_type}"
                   draggable="true" style="padding-left:4px" title="${escHtml(n.url || '')}">
                <span class="toggle"></span>
                <span class="icon">${nodeIcon(n)}</span>
                <span class="label">${escHtml(label)}</span>
                <span class="actions">${editBtn}${saveBtn}<button class="act act-del" data-id="${n.id}" title="Delete">✕</button></span>
              </div>${noteRow}`;
    }).join('');
    setStatus(`${matched.length} results`);
    return;
  }
  const session = allNodes.find(n => n.node_type === 'session');
  treeEl.innerHTML = buildTree(session ? session.id : null, 0);
}

// ── Click handler (select + collapse + double-click) ─────────────────────────

document.getElementById('tree').addEventListener('click', e => {
  if (e.target.classList.contains('act')) return; // action buttons handled separately

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
    if (n?.node_type === 'win' && n?.chrome_id) {
      // Focus open window
      chrome.windows.update(n.chrome_id, { focused: true });
    } else if (n?.node_type === 'savedwin') {
      // Re-open all saved tabs in a new window, adopting the existing DB nodes
      db.send('open_saved_window', { winNodeId: n.id })
        .then(() => scheduleRefresh())
        .catch(console.error);
    } else if (n?.is_open && n?.chrome_id) {
      // Focus existing open tab
      chrome.tabs.get(n.chrome_id).then(tab => {
        chrome.tabs.update(n.chrome_id, { active: true });
        chrome.windows.update(tab.windowId, { focused: true });
      }).catch(() => {
        if (n.url) chrome.tabs.create({ url: n.url });
      });
    } else if (n?.node_type === 'savedtab' && n?.url) {
      // Re-open saved tab; background will adopt the node instead of creating a duplicate
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
    // Close the Chrome tab; background.js onTabRemoved will mark it savedtab.
    // But if for some reason it doesn't, also force-update the node.
    if (n.chrome_id) {
      try { await chrome.tabs.remove(n.chrome_id); } catch {}
    }
    await db.upsertNode({ id, node_type: 'savedtab', is_open: 0, chrome_id: null });
    scheduleRefresh();
  }

  if (btn.classList.contains('act-del')) {
    const descIds = allDescendantIds(id);
    // Close chrome tab if open
    if (n.chrome_id && n.is_open) {
      try { await chrome.tabs.remove(n.chrome_id); } catch {}
    }
    await db.deleteNode(id); // background cascades to all descendants
    allNodes = allNodes.filter(x => !descIds.has(x.id));
    nodeMap  = Object.fromEntries(allNodes.map(x => [x.id, x]));
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
  ctx.classList.remove('hidden');
});

document.addEventListener('click', () => ctx.classList.add('hidden'));

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
  } else if (action === 'delete') {
    const descIds = allDescendantIds(selected);
    const kidCount = descIds.size - 1;
    const suffix = kidCount > 0 ? ` and ${kidCount} child node${kidCount > 1 ? 's' : ''}` : '';
    if (confirm(`Delete "${nodeLabel(n)}"${suffix}?`)) {
      if (n.chrome_id && n.is_open) { try { await chrome.tabs.remove(n.chrome_id); } catch {} }
      await db.deleteNode(selected);
      allNodes = allNodes.filter(x => !descIds.has(x.id));
      nodeMap  = Object.fromEntries(allNodes.map(x => [x.id, x]));
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

  // Mouse X relative to tree → which depth level the pointer indicates.
  // Indent formula: level 0 = 4px, each level adds 16px.
  const treeRect  = treeEl.getBoundingClientRect();
  const mouseX    = e.clientX - treeRect.left;
  const indentPx  = parseInt(node.style.paddingLeft) || 4;
  const nodeLevel = Math.round((indentPx - 4) / 16);
  const hoverLevel = Math.max(0, Math.floor((mouseX - 4) / 16));

  // Find effective parent: walk up from hovered node until we reach hoverLevel.
  // hoverLevel >= nodeLevel → drop INTO the node (it becomes the parent).
  // hoverLevel < nodeLevel  → dedent; ancestor at hoverLevel becomes parent.
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

  // Block drops that would create a cycle (parentId inside dragged subtree)
  if (parentId != null && allDescendantIds(dragSrcId).has(parentId)) return;

  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  dropState = { parentId };

  // Highlight the effective parent node
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

document.getElementById('btn-refresh').addEventListener('click', load);

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

// ── SQL panel ─────────────────────────────────────────────────────────────────

const sqlQuickEl = document.getElementById('sql-quick');
let sqlLastRows  = [];

// Load saved queries from DB and populate the <select>
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
    if (!/^\s*SELECT/i.test(sql)) load(); // refresh tree after mutations
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
  // Keep selection so the user can delete/update it
});

// ── Save current query ────────────────────────────────────────────────────────

document.getElementById('sql-save-query').addEventListener('click', async () => {
  const sql = document.getElementById('sql-input').value.trim();
  if (!sql) return;

  // If an existing query is selected, offer to update it
  const selOpt = sqlQuickEl.options[sqlQuickEl.selectedIndex];
  const selId  = selOpt?.value ? +selOpt.value : null;
  const selLabel = selOpt?.textContent ?? '';

  let label, id;
  if (selId) {
    // prompt pre-filled with existing label; empty = save as new
    label = prompt(`Update "${selLabel}" or enter a new name to save a copy:`, selLabel);
    if (label === null) return; // cancelled
    id = (label.trim() === selLabel) ? selId : null; // same name → update; new name → insert
    label = label.trim() || selLabel;
  } else {
    label = prompt('Query name:', '');
    if (!label?.trim()) return;
    id = null;
  }

  await db.send('save_quick_query', { id, label: label.trim(), sql });
  await loadQuickQueries();
  // Re-select the just-saved query
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
  { prop: '--bg',        label: 'Background',  def: '#1e1e2e' },
  { prop: '--surface',   label: 'Surface',     def: '#2a2a3e' },
  { prop: '--border',    label: 'Border',      def: '#3a3a5a' },
  { prop: '--accent',    label: 'Accent',      def: '#7c9ef8' },
  { prop: '--text',      label: 'Text',        def: '#cdd6f4' },
  { prop: '--muted',     label: 'Muted text',  def: '#6e6e8e' },
  { prop: '--hover',     label: 'Row hover',   def: '#313145' },
  { prop: '--win-icon',  label: 'Window icon', def: '#f9c74f' },
  { prop: '--tab-icon',  label: 'Tab icon',    def: '#90e0ef' },
  { prop: '--note-icon', label: 'Note icon',   def: '#a8dadc' },
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

document.querySelectorAll('.cfg-hdr').forEach(hdr => {
  hdr.addEventListener('click', () => {
    const body = document.getElementById(hdr.dataset.target);
    hdr.classList.toggle('collapsed', body.classList.toggle('hidden'));
  });
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

// ── TabOutliner import (mirrors migrate.py logic) ─────────────────────────────

function parseTabOutlinerNode(raw) {
  const ntype  = raw.type ?? 'savedtab';
  const marks  = raw.marks ?? {};
  const data   = raw.data  ?? {};
  return {
    node_type:      ntype,
    is_collapsed:   raw.colapsed ? 1 : 0,
    is_open:        (ntype === 'win' || ntype === 'tab') ? 1 : 0,
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
    return { type: n.node_type, colapsed: !!n.is_collapsed, data, marks };
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
CREATE INDEX IF NOT EXISTS idx_parent ON node (parent_id, position);
CREATE INDEX IF NOT EXISTS idx_chrome ON node (chrome_id);
CREATE INDEX IF NOT EXISTS idx_type   ON node (node_type);
CREATE VIEW IF NOT EXISTS tab_flat AS
  SELECT n.id, n.node_type, n.title, n.url, n.favicon_url,
         n.is_open, n.is_collapsed, n.position,
         n.custom_title, n.color_active, n.color_saved,
         p.id AS parent_id, p.title AS parent_title, p.node_type AS parent_type,
         n.created_at, n.updated_at
  FROM node n LEFT JOIN node p ON n.parent_id = p.id
  WHERE n.node_type IN ('tab','savedtab');
CREATE VIEW IF NOT EXISTS window_summary AS
  SELECT w.id, w.node_type,
         COALESCE(w.custom_title, w.title, 'Untitled') AS title,
         w.is_open, w.is_collapsed, w.win_rect, w.custom_favicon,
         COUNT(t.id) AS tab_count, SUM(t.is_open) AS open_tab_count
  FROM node w
  LEFT JOIN node t ON t.parent_id = w.id AND t.node_type IN ('tab','savedtab')
  WHERE w.node_type IN ('win','savedwin')
  GROUP BY w.id;
CREATE TABLE IF NOT EXISTS quick_query (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT    NOT NULL,
  sql        TEXT    NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0
);
*/`;

async function exportSQL() {
  const r     = await db.query('SELECT * FROM node ORDER BY id');
  const nodes = r?.rows ?? [];

  const cols = ['id','parent_id','node_type','position','is_collapsed','is_open',
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
