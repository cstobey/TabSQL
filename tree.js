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

    const saveBtn = (n.node_type === 'tab')
      ? `<button class="act act-save" data-id="${n.id}" title="Save &amp; close">💾</button>`
      : '';
    const delBtn  = `<button class="act act-del" data-id="${n.id}" title="Delete">✕</button>`;
    const actions = `<span class="actions">${saveBtn}${delBtn}</span>`;

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
      const label = nodeLabel(n);
      const saveBtn = n.node_type === 'tab'
        ? `<button class="act act-save" data-id="${n.id}" title="Save &amp; close">💾</button>` : '';
      return `<div class="node" data-id="${n.id}" data-type="${n.node_type}"
                   draggable="true" style="padding-left:4px" title="${escHtml(n.url || '')}">
                <span class="toggle"></span>
                <span class="icon">${nodeIcon(n)}</span>
                <span class="label">${escHtml(label)}</span>
                <span class="actions">${saveBtn}<button class="act act-del" data-id="${n.id}" title="Delete">✕</button></span>
              </div>`;
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

document.getElementById('btn-sql').addEventListener('click', () => toggleSqlPanel());

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

async function toggleSqlPanel(show) {
  const panel  = document.getElementById('sql-panel');
  const opening = show !== undefined ? show : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  if (!opening) return;
  await loadQuickQueries();
  const inp = document.getElementById('sql-input');
  inp.focus();
  if (!inp.value.trim()) {
    // Run the first saved query automatically
    const first = sqlQuickEl.options[1];
    if (first?.dataset.sql) {
      inp.value = first.dataset.sql;
      runSQL(inp.value);
    }
  }
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

document.getElementById('sql-close').addEventListener('click', () => toggleSqlPanel(false));

// ── Boot ──────────────────────────────────────────────────────────────────────

load();
