import { state } from './state.js';
import { parseSearchTerms } from './common.js';

export function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

export function nodeIcon(n) {
  switch(n.node_type) {
    case 'win':          return n.is_saved ? '📁' : (n.relicons === 'popup' ? '🔲' : '🪟');
    case 'tab':          return n.is_saved ? '·' : '⬤';
    case 'textnote':     return '📝';
    case 'split':        return '—';
    case 'group':        return '▸';
    case 'session':      return '🌳';
    default:             return '·';
  }
}

export function nodeLabel(n) {
  return n.title || n.url || n.note_text || `[${n.node_type}]`;
}

export function highlightText(text, q) {
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

export function childrenOf(parentId) {
  return state.allNodes.filter(n => n.parent_id == parentId).sort((a, b) => a.position - b.position);
}

export function allDescendantIds(nodeId) {
  const ids = new Set([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const pid = queue.shift();
    childrenOf(pid).forEach(c => { ids.add(c.id); queue.push(c.id); });
  }
  return ids;
}

export function recomputeDupUrls() {
  const urlCounts = {};
  for (const n of state.allNodes) if (n.url) urlCounts[n.url] = (urlCounts[n.url] || 0) + 1;
  state.dupUrls = new Set(Object.keys(urlCounts).filter(u => urlCounts[u] > 1));
}
