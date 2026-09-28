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
    case 'win':          return n.is_open ? (n.relicons === 'popup' ? '🔲' : '🪟') : '📁';
    case 'tab':          return n.is_open ? '⬤' : '·';
    case 'textnote':     return '📝';
    case 'split':        return '—';
    case 'group':        return '▸';
    default:             return '·';
  }
}

export function nodeLabel(n) {
  return n.title || n.url || n.note_text || `[${n.node_type}]`;
}

const DATE_TOKENS = /YYYY|YY|MM|DD|HH|H|hh|h|mm|ss|A|a/g;

export function formatDate(d, fmt) {
  const p = x => String(x).padStart(2, '0');
  const h = d.getHours(), h12 = h % 12 || 12;
  const tok = {
    YYYY: d.getFullYear(), YY: p(d.getFullYear() % 100), MM: p(d.getMonth() + 1), DD: p(d.getDate()),
    HH: p(h), H: h, hh: p(h12), h: h12, mm: p(d.getMinutes()), ss: p(d.getSeconds()),
    A: h < 12 ? 'AM' : 'PM', a: h < 12 ? 'am' : 'pm',
  };
  return fmt.replace(DATE_TOKENS, t => tok[t]);
}

// SQLite datetime('now') is UTC without a zone suffix
export function fmtDate(ts) {
  const d = ts ? new Date(ts.replace(' ', 'T') + 'Z') : null;
  if (!d || isNaN(d)) return { short: '', full: '' };
  return { short: formatDate(d, state.dateFormat), full: d.toLocaleString() };
}

// Nested markdown list of a subtree: url nodes become links, notes trail after an em
// dash. Only link-breaking characters are escaped so the raw text stays readable.
// While a search filter is active only visible descendants are included.
export function subtreeMarkdown(rootId) {
  const oneLine = s => String(s).replace(/\s+/g, ' ').trim();
  const mdText  = s => oneLine(s).replace(/([\\[\]])/g, '\\$1');
  const mdUrl   = u => u.replace(/[()\s]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  const lines = [];
  const walk = (n, depth) => {
    if (n.node_type === 'split') return;
    const label = nodeLabel(n);
    const item  = n.url ? `[${mdText(label)}](${mdUrl(n.url)})` : mdText(label);
    const note  = n.note_text && n.note_text !== label ? ` — ${oneLine(n.note_text)}` : '';
    lines.push(`${'  '.repeat(depth)}- ${item}${note}`);
    childrenOf(n.id)
      .filter(c => !state.searchVisible || state.searchVisible.has(c.id))
      .forEach(c => walk(c, depth + 1));
  };
  if (state.nodeMap[rootId]) walk(state.nodeMap[rootId], 0);
  return lines.join('\n');
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
  return state.allNodes.filter(n => n.parent_id == parentId).sort((a, b) => a.order_by - b.order_by);
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
