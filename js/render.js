import { state } from './state.js';
import { db } from './db-api.js';
import { escHtml, setStatus, nodeIcon, nodeLabel, highlightText, childrenOf, recomputeDupUrls } from './helpers.js';
import { syncFocusState, applyFocusHighlights } from './focus.js';

export async function load() {
  setStatus('Loading…');
  try {
    await syncFocusState();
    const [all, tagsR, nodeTagsR] = await Promise.all([
      db.query('SELECT * FROM node ORDER BY parent_id NULLS FIRST, position'),
      db.send('get_tags'),
      db.send('get_all_node_tags'),
    ]);
    state.allNodes = all?.rows ?? [];
    state.nodeMap  = Object.fromEntries(state.allNodes.map(n => [n.id, n]));
    const urlCounts = {};
    for (const n of state.allNodes) if (n.url) urlCounts[n.url] = (urlCounts[n.url] || 0) + 1;
    state.dupUrls = new Set(Object.keys(urlCounts).filter(u => urlCounts[u] > 1));
    state.allTags  = tagsR?.rows ?? [];
    state.nodeTagsMap = {};
    for (const nt of (nodeTagsR?.rows ?? [])) {
      if (!state.nodeTagsMap[nt.node_id]) state.nodeTagsMap[nt.node_id] = [];
      state.nodeTagsMap[nt.node_id].push({ id: nt.id, name: nt.name, color: nt.color });
    }
    render(state.allNodes);
    const openTabs = state.allNodes.filter(n => n.node_type === 'tab' && n.is_open === 1).length;
    const openWins = state.allNodes.filter(n => n.node_type === 'win' && n.is_open === 1).length;
    setStatus(`${state.allNodes.length} nodes · ${openTabs} open tab${openTabs !== 1 ? 's' : ''} · ${openWins} window${openWins !== 1 ? 's' : ''}`);
  } catch(e) {
    setStatus('Error: ' + e.message);
    console.error(e);
  }
}

export async function loadTags() {
  const r = await db.send('get_tags');
  state.allTags = r?.rows ?? [];
}

export function buildTree(parentId = null, depth = 0, searchOpts = null) {
  const allChildren = childrenOf(parentId);
  const children    = searchOpts
    ? allChildren.filter(n => searchOpts.visibleIds.has(n.id))
    : allChildren;
  if (!children.length) return '';

  return children.map(n => {
    const allKids = childrenOf(n.id);
    const visKids = searchOpts ? allKids.filter(k => searchOpts.visibleIds.has(k.id)) : allKids;
    const hasKids = visKids.length > 0;
    const isColl  = searchOpts ? false : state.collapsed.has(n.id);
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
    const isDup     = n.url && state.dupUrls.has(n.url);
    const dupIndicator = isDup ? `<span class="dup-dot" title="Duplicate URL"></span>` : '';

    const nodeTags = state.nodeTagsMap[n.id] ?? [];
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

    const cls = ['node', isOpen && isTab ? 'open-tab' : '', n.id === state.selected ? 'selected' : '']
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

export async function render(nodes, filter = '') {
  const treeEl = document.getElementById('tree');
  const searchWinBtn   = document.getElementById('btn-search-window');
  const tagSearchBtn   = document.getElementById('btn-tag-search');
  const saveSearchBtn  = document.getElementById('btn-save-search');
  const closeSearchBtn = document.getElementById('btn-close-search');
  if (filter) {
    const r = await db.send('search', { q: filter });
    const matchedCount = r?.matchedCount ?? 0;
    const visibleIds = new Set(r?.visibleIds ?? []);

    const session = state.allNodes.find(n => n.node_type === 'session');
    treeEl.innerHTML = buildTree(session ? session.id : null, 0, { visibleIds, q: filter });
    setStatus(`${matchedCount} result${matchedCount !== 1 ? 's' : ''}`);
    searchWinBtn.style.display   = matchedCount ? '' : 'none';
    tagSearchBtn.style.display   = matchedCount ? '' : 'none';
    saveSearchBtn.style.display  = matchedCount ? '' : 'none';
    closeSearchBtn.style.display = matchedCount ? '' : 'none';
    applyFocusHighlights();
    return;
  }
  searchWinBtn.style.display   = 'none';
  tagSearchBtn.style.display   = 'none';
  saveSearchBtn.style.display  = 'none';
  closeSearchBtn.style.display = 'none';
  const session = state.allNodes.find(n => n.node_type === 'session');
  treeEl.innerHTML = buildTree(session ? session.id : null, 0);
  applyFocusHighlights();
}
