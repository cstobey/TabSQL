'use strict';

importScripts('sql-wasm.js');

const DB_KEY = 'tabsql_db_v1';

const DEFAULT_QUICK_QUERIES = [
  { label: 'Node counts',    sql: `SELECT node_type, COUNT(*) c FROM node GROUP BY node_type ORDER BY c DESC` },
  { label: 'Open tabs',      sql: `SELECT * FROM node WHERE is_open=1 AND node_type='tab' ORDER BY position` },
  { label: 'Saved tabs',     sql: `SELECT * FROM node WHERE node_type='savedtab' ORDER BY updated_at DESC LIMIT 100` },
  { label: 'Window summary', sql: `SELECT * FROM window_summary ORDER BY tab_count DESC` },
  { label: 'Tab flat view',  sql: `SELECT * FROM tab_flat LIMIT 100` },
  { label: 'Duplicate URLs', sql: `SELECT url, COUNT(*) c FROM node WHERE url IS NOT NULL GROUP BY url HAVING c>1 ORDER BY c DESC` },
  { label: 'Recently added', sql: `SELECT * FROM node ORDER BY created_at DESC LIMIT 50` },
  { label: 'All notes',      sql: `SELECT * FROM node WHERE note_text IS NOT NULL ORDER BY updated_at DESC` },
];

let SQL         = null;
let db          = null;
let dbReady     = null;   // promise — prevents concurrent init races
let pendingAdopt = null;  // { nodeId, url, ts } — set by pre_open_tab message

// ---------------------------------------------------------------------------
// DB init & persistence
// ---------------------------------------------------------------------------

async function _initDb() {
  SQL = await initSqlJs({ locateFile: () => chrome.runtime.getURL('sql-wasm.wasm') });
  const stored = await chrome.storage.local.get(DB_KEY);
  if (stored[DB_KEY]) {
    db = new SQL.Database(new Uint8Array(stored[DB_KEY]));
  } else {
    db = new SQL.Database();
  }
  applySchema(); // always run; all statements use IF NOT EXISTS
}

async function ensureDb() {
  if (db) return;
  if (!dbReady) dbReady = _initDb();
  await dbReady;
}

async function persistDb() {
  if (!db) return;
  const data = db.export();
  await chrome.storage.local.set({ [DB_KEY]: Array.from(data) });
}

function applySchema() {
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_qquery_pos ON quick_query (position);
  `);
  // Seed defaults on first creation (empty table)
  const count = sqlQuery('SELECT COUNT(*) c FROM quick_query')[0]?.c ?? 0;
  if (+count === 0) seedDefaultQueries();
}

function seedDefaultQueries() {
  DEFAULT_QUICK_QUERIES.forEach((q, i) => {
    sqlInsert(
      'INSERT INTO quick_query (label, sql, position, is_default) VALUES (?,?,?,1)',
      [q.label, q.sql, i]
    );
  });
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

function sqlQuery(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function sqlRun(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.run(params);
  stmt.free();
}

function sqlInsert(sql, params = []) {
  sqlRun(sql, params);
  return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
}

// ---------------------------------------------------------------------------
// Node operations
// ---------------------------------------------------------------------------

function upsertNode(node) {
  const cols = Object.keys(node).filter(k => k !== 'id');
  if ('id' in node) {
    const set = cols.map(c => `${c} = ?`).join(', ');
    sqlRun(
      `UPDATE node SET ${set}, updated_at=datetime('now') WHERE id=?`,
      [...cols.map(c => node[c] ?? null), node.id]
    );
    return node.id;
  }
  const colNames = cols.join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  return sqlInsert(
    `INSERT INTO node (${colNames}) VALUES (${placeholders})`,
    cols.map(c => node[c] ?? null)
  );
}

// ---------------------------------------------------------------------------
// Message handler (used by sidebar, SQL console, and event helpers)
// ---------------------------------------------------------------------------

async function handleMessage(cmd, payload) {
  await ensureDb();
  switch (cmd) {
    case 'ping':
      return { ok: true };

    case 'get_tree': {
      const pid = payload?.parent_id ?? null;
      const rows = pid === null
        ? sqlQuery('SELECT * FROM node WHERE parent_id IS NULL ORDER BY position')
        : sqlQuery('SELECT * FROM node WHERE parent_id=? ORDER BY position', [pid]);
      return { ok: true, rows };
    }

    case 'upsert_node': {
      const id = upsertNode(payload.node);
      await persistDb();
      return { ok: true, id };
    }

    case 'delete_node': {
      // Cascade-delete all descendants
      const toDelete = [payload.id];
      const queue = [payload.id];
      while (queue.length) {
        const pid = queue.shift();
        const kids = sqlQuery('SELECT id FROM node WHERE parent_id=?', [pid]);
        kids.forEach(k => { toDelete.push(k.id); queue.push(k.id); });
      }
      toDelete.forEach(id => sqlRun('DELETE FROM node WHERE id=?', [id]));
      await persistDb();
      return { ok: true };
    }

    case 'move_node':
      sqlRun(
        `UPDATE node SET parent_id=?, position=?, updated_at=datetime('now') WHERE id=?`,
        [payload.parent_id, payload.position, payload.id]
      );
      await persistDb();
      return { ok: true };

    case 'bulk_exec': {
      const sql = payload.sql;
      const rows = sqlQuery(sql);
      if (!/^\s*SELECT/i.test(sql)) await persistDb();
      return { ok: true, rows };
    }

    case 'search': {
      const like = `%${payload.q}%`;
      const rows = sqlQuery(
        'SELECT * FROM node WHERE title LIKE ? OR url LIKE ? OR note_text LIKE ? LIMIT 200',
        [like, like, like]
      );
      return { ok: true, rows };
    }

    case 'get_node': {
      const rows = sqlQuery('SELECT * FROM node WHERE id=?', [payload.id]);
      return { ok: true, row: rows[0] ?? null };
    }

    case 'import_nodes': {
      for (const node of payload.nodes) upsertNode(node);
      await persistDb();
      return { ok: true, count: payload.nodes.length };
    }

    case 'pre_open_tab':
      pendingAdopt = { nodeId: payload.nodeId, url: payload.url, ts: Date.now() };
      return { ok: true };

    case 'get_quick_queries': {
      const rows = sqlQuery('SELECT * FROM quick_query ORDER BY position, label');
      return { ok: true, rows };
    }

    case 'save_quick_query': {
      const { id, label, sql } = payload;
      if (id) {
        sqlRun('UPDATE quick_query SET label=?, sql=? WHERE id=?', [label, sql, id]);
      } else {
        const maxPos = sqlQuery('SELECT MAX(position) m FROM quick_query')[0]?.m ?? -1;
        sqlInsert(
          'INSERT INTO quick_query (label, sql, position, is_default) VALUES (?,?,?,0)',
          [label, sql, maxPos + 1]
        );
      }
      await persistDb();
      return { ok: true };
    }

    case 'delete_quick_query':
      sqlRun('DELETE FROM quick_query WHERE id=?', [payload.id]);
      await persistDb();
      return { ok: true };

    case 'seed_default_queries': {
      const existing = new Set(
        sqlQuery('SELECT label FROM quick_query').map(r => r.label)
      );
      let added = 0;
      DEFAULT_QUICK_QUERIES.forEach((q, i) => {
        if (!existing.has(q.label)) {
          sqlInsert(
            'INSERT INTO quick_query (label, sql, position, is_default) VALUES (?,?,?,1)',
            [q.label, q.sql, i]
          );
          added++;
        }
      });
      await persistDb();
      return { ok: true, added };
    }

    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.to !== 'background') return;
  handleMessage(msg.cmd, msg.payload)
    .then(r  => sendResponse({ ok: true,  data: r }))
    .catch(e => sendResponse({ ok: false, error: e.message }));
  return true;
});

// ---------------------------------------------------------------------------
// Tab / window sync
// ---------------------------------------------------------------------------

async function upsertWin(chromeWin) {
  await ensureDb();
  const id = upsertNode({
    node_type: 'win',
    is_open:   1,
    chrome_id: chromeWin.id,
    win_rect:  `${chromeWin.left}_${chromeWin.top}_${chromeWin.width}_${chromeWin.height}`,
    relicons:  chromeWin.type ?? 'normal',
  });
  await persistDb();
  return id;
}

async function upsertTab(chromeTab, parentDbId) {
  await ensureDb();
  const node = {
    node_type:   'tab',
    is_open:     1,
    chrome_id:   chromeTab.id,
    title:       chromeTab.title      ?? '',
    url:         chromeTab.url        ?? '',
    favicon_url: chromeTab.favIconUrl ?? '',
    position:    chromeTab.index      ?? 0,
  };
  if (parentDbId != null) node.parent_id = parentDbId;
  const id = upsertNode(node);
  await persistDb();
  return id;
}

async function winDbId(chromeWinId) {
  await ensureDb();
  const rows = sqlQuery(
    `SELECT id FROM node WHERE node_type IN ('win','savedwin') AND chrome_id=? LIMIT 1`,
    [chromeWinId]
  );
  return rows[0]?.id ?? null;
}

async function tabDbId(chromeTabId) {
  await ensureDb();
  const rows = sqlQuery(
    `SELECT id FROM node WHERE node_type IN ('tab','savedtab') AND chrome_id=? LIMIT 1`,
    [chromeTabId]
  );
  return rows[0]?.id ?? null;
}

async function initialize() {
  await ensureDb();
  const wins = await chrome.windows.getAll({ populate: true });
  for (const win of wins) {
    const wid = await upsertWin(win);
    for (const tab of (win.tabs ?? [])) await upsertTab(tab, wid);
  }
  await persistDb();
  console.log('TabSQL initialized');
}

// ---------------------------------------------------------------------------
// Chrome event handlers
// ---------------------------------------------------------------------------

async function onWindowCreated(win)  { await upsertWin(win); }

function saveDescendantTabs(nodeId) {
  // Recursively mark all tab descendants of nodeId as savedtab
  const children = sqlQuery('SELECT id, node_type FROM node WHERE parent_id=?', [nodeId]);
  for (const child of children) {
    if (child.node_type === 'tab') {
      sqlRun(
        `UPDATE node SET node_type='savedtab', is_open=0, chrome_id=NULL, updated_at=datetime('now') WHERE id=?`,
        [child.id]
      );
      saveDescendantTabs(child.id);
    }
  }
}

async function onWindowRemoved(winId) {
  await ensureDb();
  const winRows = sqlQuery(
    `SELECT id FROM node WHERE node_type='win' AND chrome_id=? LIMIT 1`, [winId]
  );
  if (winRows.length) saveDescendantTabs(winRows[0].id);
  sqlRun(
    `UPDATE node SET node_type='savedwin', is_open=0, chrome_id=NULL, updated_at=datetime('now')
     WHERE node_type='win' AND chrome_id=?`,
    [winId]
  );
  await persistDb();
}

async function onTabCreated(tab) {
  // Adopt a pending saved-tab node if tree.js called pre_open_tab first
  if (pendingAdopt && (Date.now() - pendingAdopt.ts < 5000)) {
    const { nodeId } = pendingAdopt;
    pendingAdopt = null;
    const pid = await winDbId(tab.windowId);
    upsertNode({
      id:          nodeId,
      chrome_id:   tab.id,
      is_open:     1,
      node_type:   'tab',
      parent_id:   pid,
      title:       tab.title      ?? '',
      url:         tab.url        ?? '',
      favicon_url: tab.favIconUrl ?? '',
      position:    tab.index      ?? 0,
    });
    await persistDb();
    return;
  }

  // Place tab under its opener tab if one exists, otherwise under the window
  let pid = null;
  if (tab.openerTabId) pid = await tabDbId(tab.openerTabId);
  if (pid == null)     pid = await winDbId(tab.windowId);
  await upsertTab(tab, pid);
}

async function onTabRemoved(tabId, info) {
  if (info.isWindowClosing) return;
  await ensureDb();
  sqlRun(
    `UPDATE node SET node_type='savedtab', is_open=0, chrome_id=NULL, updated_at=datetime('now')
     WHERE node_type='tab' AND chrome_id=?`,
    [tabId]
  );
  await persistDb();
}

async function onTabUpdated(tabId, changeInfo, tab) {
  if (!changeInfo.url && !changeInfo.title && !changeInfo.favIconUrl) return;
  const id = await tabDbId(tabId);
  if (id == null) return;
  await ensureDb();
  upsertNode({ id, title: tab.title ?? '', url: tab.url ?? '', favicon_url: tab.favIconUrl ?? '' });
  await persistDb();
}

function guard(fn) {
  return (...args) => fn(...args).catch(e => console.error(fn.name + ':', e));
}

chrome.windows.onCreated.addListener(guard(onWindowCreated));
chrome.windows.onRemoved.addListener(guard(onWindowRemoved));
chrome.tabs.onCreated.addListener(guard(onTabCreated));
chrome.tabs.onRemoved.addListener(guard(onTabRemoved));
chrome.tabs.onUpdated.addListener(guard(onTabUpdated));

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener(() => {
  chrome.windows.create({
    url: chrome.runtime.getURL('index.html'),
    type: 'popup', width: 400, height: 800,
  });
});
chrome.commands.onCommand.addListener(cmd => {
  if (cmd === 'open_sidebar') chrome.action.onClicked.dispatch();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

initialize().catch(e => console.error('TabSQL boot error:', e));
