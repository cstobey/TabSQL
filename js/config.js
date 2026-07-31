import { db } from './db-api.js';
import { escHtml } from './helpers.js';
import { load } from './render.js';

export const COLOR_VARS = [
  { prop: '--bg',        label: 'Background',       def: '#1e1e2e' },
  { prop: '--surface',   label: 'Surface',          def: '#2a2a3e' },
  { prop: '--border',    label: 'Border',           def: '#3a3a5a' },
  { prop: '--accent',    label: 'Accent',           def: '#7c9ef8' },
  { prop: '--text',      label: 'Text',             def: '#cdd6f4' },
  { prop: '--muted',     label: 'Muted text',       def: '#6e6e8e' },
  { prop: '--hover',     label: 'Row hover',        def: '#313145' },
  { prop: '--win-icon',  label: 'Window icon',      def: '#f9c74f' },
  { prop: '--tab-icon',  label: 'Tab icon',         def: '#90e0ef' },
  { prop: '--note-icon', label: 'Note icon',        def: '#a8dadc' },
  { prop: '--search-hl', label: 'Search highlight', def: '#5a4a00' },
  { prop: '--dup-url',   label: 'Duplicate URL',    def: '#f38ba8' },
  { prop: '--saved-tab', label: 'Saved marker',     def: '#a6e3a1' },
  { prop: '--focus-bg',  label: 'Focus highlight',  def: '#1a3a5c' },
];

export async function loadTheme() {
  const r = await db.send('get_config');
  const stored = r?.values ?? {};
  // One-time migration from old chrome.storage.local theme key
  if (!Object.keys(stored).some(k => k.startsWith('color_'))) {
    try {
      const old = await chrome.storage.local.get('tabsql_theme');
      if (old.tabsql_theme && Object.keys(old.tabsql_theme).length) {
        const entries = {};
        for (const [k, v] of Object.entries(old.tabsql_theme)) entries[`color_${k}`] = v;
        await db.send('set_config', { entries });
        Object.assign(stored, entries);
      }
    } catch {}
  }
  const theme = {};
  COLOR_VARS.forEach(cv => {
    const v = stored[`color_${cv.prop}`] ?? cv.def;
    document.documentElement.style.setProperty(cv.prop, v);
    theme[cv.prop] = v;
  });
  return theme;
}

export function buildColorGrid(theme) {
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
      await db.send('set_config', { key: `color_${inp.dataset.prop}`, value: inp.value });
    });
  });
}

document.getElementById('btn-config').addEventListener('click', () => {
  document.getElementById('config-panel').classList.toggle('hidden');
});

document.getElementById('cfg-colors-reset').addEventListener('click', async () => {
  const entries = {};
  COLOR_VARS.forEach(cv => {
    document.documentElement.style.setProperty(cv.prop, cv.def);
    entries[`color_${cv.prop}`] = cv.def;
  });
  await db.send('set_config', { entries });
  buildColorGrid(Object.fromEntries(COLOR_VARS.map(cv => [cv.prop, cv.def])));
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

// Imported content is an archive: everything lands closed, and tabs/windows land
// saved so the next resync's stale cleanup can never purge them. TabOutliner custom
// title/favicon marks fold into the plain columns; 'separatorline' maps to 'split'.
function parseTabOutlinerNode(raw) {
  let ntype = raw.type ?? 'tab';
  let is_saved = 0;
  if      (ntype === 'savedtab')      { ntype = 'tab'; is_saved = 1; }
  else if (ntype === 'savedwin')      { ntype = 'win'; is_saved = 1; }
  else if (ntype === 'separatorline') { ntype = 'split'; }
  if (ntype === 'tab' || ntype === 'win') is_saved = 1;
  const marks  = raw.marks ?? {};
  const data   = raw.data  ?? {};
  return {
    node_type:    ntype,
    is_saved,
    is_collapsed: raw.colapsed ? 1 : 0,
    is_open:      0,
    title:        marks.customTitle   ?? data.title       ?? null,
    url:          data.url            ?? null,
    favicon_url:  marks.customFavicon ?? data.favIconUrl  ?? null,
    note_text:    data.note           ?? null,
    color_active: marks.customColorActive ?? null,
    color_saved:  marks.customColorSaved  ?? null,
    relicons:     marks.relicons ? JSON.stringify(marks.relicons) : null,
    win_rect:     data.rect ?? null,
    chrome_id:    null,
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
    node.position  = posCounter[parentKey];
    node.order_by  = posCounter[parentKey]++;

    const cleaned = Object.fromEntries(Object.entries(node).filter(([, v]) => v != null));
    const result  = await db.send('upsert_node', { node: cleaned });
    pathToId[pathKey] = result?.id;
  }
}

// ── TabOutliner export ────────────────────────────────────────────────────────

async function exportTabOutliner() {
  const r     = await db.query('SELECT * FROM node ORDER BY parent_id NULLS FIRST, order_by');
  const nodes = r?.rows ?? [];

  function toToNode(n) {
    const marks = {};
    if (n.color_active) marks.customColorActive = n.color_active;
    if (n.color_saved)  marks.customColorSaved  = n.color_saved;
    if (n.relicons) { try { marks.relicons = JSON.parse(n.relicons); } catch {} }
    const data = {};
    if (n.title)       data.title      = n.title;
    if (n.url)         data.url        = n.url;
    if (n.favicon_url) data.favIconUrl = n.favicon_url;
    if (n.note_text)   data.note       = n.note_text;
    if (n.win_rect)    data.rect       = n.win_rect;
    const exportType = (n.node_type === 'win' && !n.is_open) ? 'savedwin'
                     : (n.node_type === 'tab' && !n.is_open) ? 'savedtab'
                     : n.node_type === 'split' ? 'separatorline'
                     : n.node_type;
    return { type: exportType, colapsed: !!n.is_collapsed, data, marks };
  }

  const result = [{ type: 'TREE_CREATE', treeStorage: 'TabSQL export' }];

  function traverse(parentId, pathSoFar) {
    nodes.filter(n => n.parent_id == parentId)
         .sort((a, b) => a.order_by - b.order_by)
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
  is_pinned      INTEGER NOT NULL DEFAULT 0,
  order_by       INTEGER NOT NULL DEFAULT 0,
  chrome_id      INTEGER DEFAULT NULL,
  title          TEXT,
  url            TEXT,
  domain         TEXT,
  favicon_url    TEXT,
  note_text      TEXT,
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
                'is_pinned','order_by','chrome_id','title','url','domain','favicon_url',
                'note_text','color_active','color_saved','relicons','win_rect',
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
