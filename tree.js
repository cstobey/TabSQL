// tree.js - sidebar UI
'use strict';

// -------------------------------------------------------------------------
// DB API (via background service worker)
// -------------------------------------------------------------------------

const db = {
  async send(cmd, payload = {}) {
    return new Promise((res, rej) => {
      chrome.runtime.sendMessage({ to: 'background', cmd, payload }, r => {
        if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
        else if (r?.ok === false) rej(new Error(r.error));
        else res(r?.data);
      });
    });
  },
  getTree(parent_id = null) { return this.send('get_tree', { parent_id }); },
  deleteNode(id)             { return this.send('delete_node', { id }); },
  moveNode(id, parent_id, position) { return this.send('move_node', { id, parent_id, position }); },
  query(sql)                 { return this.send('bulk_exec', { sql }); },
};

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

let allNodes = [];
let nodeMap  = {};         // id -> node
let collapsed = new Set(); // ids
let selected  = null;

// -------------------------------------------------------------------------
// Load & render
// -------------------------------------------------------------------------

async function load() {
  setStatus('Loading…');
  try {
    const r = await db.getTree();          // root nodes
    if (!r?.rows) throw new Error('No response from host');
    allNodes = r.rows;
    // Load all children recursively via a single flat fetch
    const all = await db.query('SELECT * FROM node ORDER BY parent_id NULLS FIRST, position');
    if (all?.rows) {
      allNodes = all.rows;
      nodeMap = Object.fromEntries(allNodes.map(n => [n.id, n]));
    }
    render(allNodes);
    setStatus(`${allNodes.length} nodes`);
  } catch(e) {
    setStatus('Error: ' + e.message);
    console.error(e);
  }
}

function childrenOf(parentId) {
  return allNodes
    .filter(n => n.parent_id == parentId)
    .sort((a, b) => a.position - b.position);
}

function nodeIcon(n) {
  switch(n.node_type) {
    case 'win':         return '🪟';
    case 'savedwin':    return '📁';
    case 'tab':         return '⬤';
    case 'savedtab':    return '·';
    case 'textnote':    return '📝';
    case 'separatorline': return '—';
    case 'group':       return '▸';
    case 'session':     return '🌳';
    default:            return '·';
  }
}

function nodeLabel(n) {
  return n.custom_title || n.title || n.url || n.note_text || `[${n.node_type}]`;
}

function buildTree(parentId = null, depth = 0) {
  const children = childrenOf(parentId);
  if (!children.length) return '';

  return children.map(n => {
    const kids     = childrenOf(n.id);
    const hasKids  = kids.length > 0;
    const isColl   = collapsed.has(n.id);
    const isOpen   = n.is_open === 1;
    const indent   = depth * 16;
    const label    = nodeLabel(n);
    const icon     = nodeIcon(n);
    const badge    = hasKids ? `<span class="badge">${kids.length}</span>` : '';
    const toggle   = hasKids
      ? `<span class="toggle">${isColl ? '▶' : '▼'}</span>`
      : `<span class="toggle"></span>`;

    let faviconHtml = '';
    if (n.favicon_url && n.favicon_url.startsWith('http')) {
      faviconHtml = `<img class="favicon" src="${escHtml(n.favicon_url)}" onerror="this.style.display='none'">`;
    }

    const cls = [
      'node',
      isOpen ? 'open-tab' : '',
      n.id === selected ? 'selected' : '',
    ].filter(Boolean).join(' ');

    const kidHtml = hasKids && !isColl ? buildTree(n.id, depth + 1) : '';

    return `<div class="${cls}" data-id="${n.id}" data-type="${n.node_type}"
                 style="padding-left:${indent + 4}px" title="${escHtml(n.url || '')}">
              ${toggle}
              ${faviconHtml || `<span class="icon">${icon}</span>`}
              <span class="label ${label ? '' : 'muted'}">${escHtml(label)}</span>
              ${badge}
            </div>
            ${kidHtml}`;
  }).join('');
}

function render(nodes, filter = '') {
  const tree = document.getElementById('tree');
  if (filter) {
    const q = filter.toLowerCase();
    const matched = allNodes.filter(n =>
      (n.title||'').toLowerCase().includes(q) ||
      (n.url||'').toLowerCase().includes(q) ||
      (n.note_text||'').toLowerCase().includes(q) ||
      (n.custom_title||'').toLowerCase().includes(q)
    );
    tree.innerHTML = matched.map(n => {
      const label = nodeLabel(n);
      return `<div class="node" data-id="${n.id}" data-type="${n.node_type}" style="padding-left:4px"
                   title="${escHtml(n.url || '')}">
                <span class="toggle"></span>
                <span class="icon">${nodeIcon(n)}</span>
                <span class="label">${escHtml(label)}</span>
              </div>`;
    }).join('');
    setStatus(`${matched.length} results`);
    return;
  }

  // Find session or true root
  const session = allNodes.find(n => n.node_type === 'session');
  tree.innerHTML = buildTree(session ? session.id : null, 0);
}

// -------------------------------------------------------------------------
// Events
// -------------------------------------------------------------------------

document.getElementById('tree').addEventListener('click', e => {
  const node = e.target.closest('.node');
  if (!node) return;
  const id = +node.dataset.id;
  const n  = nodeMap[id];

  if (e.target.classList.contains('toggle')) {
    toggleCollapse(id, node);
    return;
  }

  selected = id;
  document.querySelectorAll('.node.selected').forEach(el => el.classList.remove('selected'));
  node.classList.add('selected');

  // Double-click: open URL
  if (e.detail === 2 && n?.url) {
    chrome.tabs.create({ url: n.url });
  }
});

document.getElementById('tree').addEventListener('contextmenu', e => {
  e.preventDefault();
  const node = e.target.closest('.node');
  if (!node) return;
  selected = +node.dataset.id;
  showCtx(e.clientX, e.clientY);
});

function toggleCollapse(id, el) {
  if (collapsed.has(id)) {
    collapsed.delete(id);
  } else {
    collapsed.add(id);
  }
  render(allNodes, document.getElementById('search').value);
}

// Context menu
const ctx = document.getElementById('ctx');
function showCtx(x, y) {
  ctx.style.left = x + 'px';
  ctx.style.top  = y + 'px';
  ctx.classList.remove('hidden');
}
document.addEventListener('click', () => ctx.classList.add('hidden'));

ctx.addEventListener('click', async e => {
  const action = e.target.dataset.action;
  if (!action || !selected) return;
  const n = nodeMap[selected];

  if (action === 'open' && n?.url) {
    chrome.tabs.create({ url: n.url });
  } else if (action === 'open-all') {
    const kids = childrenOf(selected);
    for (const k of kids) if (k.url) chrome.tabs.create({ url: k.url });
  } else if (action === 'copy-url' && n?.url) {
    await navigator.clipboard.writeText(n.url);
  } else if (action === 'copy-title') {
    await navigator.clipboard.writeText(nodeLabel(n));
  } else if (action === 'delete') {
    if (confirm(`Delete "${nodeLabel(n)}"?`)) {
      await db.deleteNode(selected);
      allNodes = allNodes.filter(x => x.id !== selected);
      nodeMap = Object.fromEntries(allNodes.map(x => [x.id, x]));
      render(allNodes, document.getElementById('search').value);
    }
  }
});

// Search
let searchTimer = null;
document.getElementById('search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => render(allNodes, e.target.value.trim()), 200);
});

document.getElementById('btn-refresh').addEventListener('click', load);

document.getElementById('btn-sql').addEventListener('click', () => {
  chrome.windows.create({
    url: 'http://127.0.0.1:7779/',
    type: 'popup', width: 900, height: 600
  });
});

// -------------------------------------------------------------------------
// Utils
// -------------------------------------------------------------------------

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

// -------------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------------

load();
