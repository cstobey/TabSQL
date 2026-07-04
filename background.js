'use strict';

importScripts('sql-wasm.js');

const DB_KEY = 'tabsql_db_v1';
let SQL = null;
let db  = null;

// ---------------------------------------------------------------------------
// DB init & persistence
// ---------------------------------------------------------------------------

async function ensureDb() {
  if (db) return;
  if (!SQL) {
    SQL = await initSqlJs({ locateFile: () => chrome.runtime.getURL('sql-wasm.wasm') });
  }
  const stored = await chrome.storage.local.get(DB_KEY);
  if (stored[DB_KEY]) {
    db = new SQL.Database(new Uint8Array(stored[DB_KEY]));
  } else {
    db = new SQL.Database();
    applySchema();
  }
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
  `);
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

    case 'delete_node':
      sqlRun('DELETE FROM node WHERE id=?', [payload.id]);
      await persistDb();
      return { ok: true };

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

async function onWindowRemoved(winId) {
  await ensureDb();
  sqlRun(
    `UPDATE node SET node_type='savedtab', is_open=0, updated_at=datetime('now')
     WHERE node_type='tab' AND parent_id=(
       SELECT id FROM node WHERE node_type='win' AND chrome_id=? LIMIT 1)`,
    [winId]
  );
  sqlRun(
    `UPDATE node SET node_type='savedwin', is_open=0, chrome_id=NULL, updated_at=datetime('now')
     WHERE node_type='win' AND chrome_id=?`,
    [winId]
  );
  await persistDb();
}

async function onTabCreated(tab) {
  const pid = await winDbId(tab.windowId);
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
