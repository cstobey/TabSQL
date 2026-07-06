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
let pendingAdopt  = null;       // { nodeId, url, ts } — set by pre_open_tab message
let adoptedTabIds = new Set(); // chrome tab IDs adopted by open_saved_window; skip in onTabCreated

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

    case 'open_saved_window': {
      const savedTabs = sqlQuery(
        `SELECT id, url, position FROM node WHERE parent_id=? AND node_type='savedtab' AND url IS NOT NULL ORDER BY position`,
        [payload.winNodeId]
      );
      if (!savedTabs.length) return { ok: true };
      const newWin = await chrome.windows.create({ url: savedTabs.map(t => t.url) });
      // Update the savedwin node back to an open win
      upsertNode({ id: payload.winNodeId, node_type: 'win', is_open: 1, chrome_id: newWin.id });
      // Match created tabs 1:1 to saved nodes and mark them so onTabCreated skips them
      const chromeTabs = newWin.tabs ?? [];
      for (let i = 0; i < Math.min(savedTabs.length, chromeTabs.length); i++) {
        upsertNode({ id: savedTabs[i].id, chrome_id: chromeTabs[i].id, is_open: 1, node_type: 'tab', position: i });
        adoptedTabIds.add(chromeTabs[i].id);
      }
      await persistDb();
      return { ok: true };
    }

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

    case 'exec_raw': {
      db.exec(payload.sql);
      await persistDb();
      return { ok: true };
    }

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
  const existing = sqlQuery(
    `SELECT id FROM node WHERE chrome_id=? AND node_type IN ('win','savedwin') LIMIT 1`,
    [chromeWin.id]
  )[0];
  const node = {
    node_type: 'win',
    is_open:   1,
    chrome_id: chromeWin.id,
    win_rect:  `${chromeWin.left}_${chromeWin.top}_${chromeWin.width}_${chromeWin.height}`,
    relicons:  chromeWin.type ?? 'normal',
  };
  if (existing) node.id = existing.id;
  const id = upsertNode(node);
  await persistDb();
  return id;
}

async function upsertTab(chromeTab, parentDbId) {
  await ensureDb();
  const existing = sqlQuery(
    `SELECT id FROM node WHERE chrome_id=? AND node_type IN ('tab','savedtab') LIMIT 1`,
    [chromeTab.id]
  )[0];
  const node = {
    node_type:   'tab',
    is_open:     1,
    chrome_id:   chromeTab.id,
    title:       chromeTab.title      ?? '',
    url:         chromeTab.url        ?? '',
    favicon_url: chromeTab.favIconUrl ?? '',
    position:    chromeTab.index      ?? 0,
  };
  if (existing) {
    node.id = existing.id; // update in place, preserve parent/position set by user
  } else if (parentDbId != null) {
    node.parent_id = parentDbId;
  }
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

// Returns true if nodeId has any savedtab descendant at any depth
function hasSavedDescendants(nodeId) {
  const children = sqlQuery('SELECT id, node_type FROM node WHERE parent_id=?', [nodeId]);
  for (const child of children) {
    if (child.node_type === 'savedtab') return true;
    if (hasSavedDescendants(child.id)) return true;
  }
  return false;
}

// Delete open tab descendants, re-parenting any savedtab children up the tree
function deleteOpenDescendants(nodeId, newParentId) {
  const children = sqlQuery('SELECT id, node_type FROM node WHERE parent_id=?', [nodeId]);
  for (const child of children) {
    if (child.node_type === 'savedtab') {
      // Promote saved tab to the grandparent so it isn't orphaned
      sqlRun(`UPDATE node SET parent_id=? WHERE id=?`, [newParentId, child.id]);
    } else if (child.node_type === 'tab') {
      deleteOpenDescendants(child.id, newParentId ?? nodeId);
      sqlRun('DELETE FROM node WHERE id=?', [child.id]);
    }
  }
}

async function onWindowCreated(win) { await upsertWin(win); }

async function onWindowRemoved(winId) {
  await ensureDb();
  const winRow = sqlQuery(`SELECT id FROM node WHERE node_type='win' AND chrome_id=? LIMIT 1`, [winId])[0];
  if (!winRow) return;
  // onTabRemoved already fired for each tab; clean up any stragglers and re-parent saved content
  deleteOpenDescendants(winRow.id, null);
  if (hasSavedDescendants(winRow.id)) {
    // Keep the window node as savedwin to preserve the saved tab group
    sqlRun(`UPDATE node SET node_type='savedwin', is_open=0, chrome_id=NULL, updated_at=datetime('now') WHERE id=?`, [winRow.id]);
  } else {
    sqlRun('DELETE FROM node WHERE id=?', [winRow.id]);
  }
  await persistDb();
}

async function onTabCreated(tab) {
  // Tab adopted by open_saved_window — already updated in the handler
  if (adoptedTabIds.has(tab.id)) {
    adoptedTabIds.delete(tab.id);
    return;
  }

  // Adopt a pending saved-tab node (tree.js called pre_open_tab before chrome.tabs.create)
  if (pendingAdopt && (Date.now() - pendingAdopt.ts < 5000)) {
    const { nodeId } = pendingAdopt;
    pendingAdopt = null;
    const savedPos = sqlQuery('SELECT position FROM node WHERE id=?', [nodeId])[0]?.position ?? -1;
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
    // Restore the tab's original position in the tab bar
    if (savedPos >= 0 && savedPos !== tab.index) {
      try { await chrome.tabs.move(tab.id, { index: savedPos }); } catch {}
    }
    return;
  }

  // Place tab under its opener tab if one exists, otherwise under the window
  let pid = null;
  if (tab.openerTabId) pid = await tabDbId(tab.openerTabId);
  if (pid == null)     pid = await winDbId(tab.windowId);
  await upsertTab(tab, pid);
}

async function onTabRemoved(tabId, _info) {
  // Always delete — only the manual 💾 button keeps tabs saved
  await ensureDb();
  const row = sqlQuery(`SELECT id, parent_id FROM node WHERE node_type='tab' AND chrome_id=? LIMIT 1`, [tabId])[0];
  if (!row) return;
  // Re-parent any savedtab children so they aren't orphaned
  sqlRun(`UPDATE node SET parent_id=? WHERE parent_id=? AND node_type='savedtab'`, [row.parent_id, row.id]);
  sqlRun('DELETE FROM node WHERE id=?', [row.id]);
  await persistDb();
}

async function onTabMoved(tabId, moveInfo) {
  const id = await tabDbId(tabId);
  if (id == null) return;
  sqlRun(`UPDATE node SET position=?, updated_at=datetime('now') WHERE id=?`, [moveInfo.toIndex, id]);
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
chrome.tabs.onMoved.addListener(guard(onTabMoved));

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
