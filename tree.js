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
    if (n?.is_open && n?.chrome_id) {
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
    const kidCount = descIds.size - 1;
    const suffix = kidCount > 0 ? ` and ${kidCount} child node${kidCount > 1 ? 's' : ''}` : '';
    if (!confirm(`Delete "${nodeLabel(n)}"${suffix}?`)) return;
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
});

treeEl.addEventListener('dragover', e => {
  if (!dragSrcId) return;
  const node = e.target.closest('.node');
  if (!node) return;
  const targetId = +node.dataset.id;
  if (targetId === dragSrcId) return;
  if (allDescendantIds(dragSrcId).has(targetId)) return; // prevent cycle
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  treeEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  node.classList.add('drag-over');
});

treeEl.addEventListener('dragleave', e => {
  const node = e.target.closest('.node');
  if (node) node.classList.remove('drag-over');
});

treeEl.addEventListener('drop', async e => {
  e.preventDefault();
  const node = e.target.closest('.node');
  if (!node || !dragSrcId) return;
  const targetId = +node.dataset.id;
  if (targetId === dragSrcId || allDescendantIds(dragSrcId).has(targetId)) return;
  node.classList.remove('drag-over');
  const pos = childrenOf(targetId).length; // append as last child
  await db.moveNode(dragSrcId, targetId, pos);
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

document.getElementById('btn-sql').addEventListener('click', () => {
  chrome.windows.create({
    url: chrome.runtime.getURL('management_ui.html'),
    type: 'popup', width: 900, height: 600,
  });
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

// ── Boot ──────────────────────────────────────────────────────────────────────

load();
