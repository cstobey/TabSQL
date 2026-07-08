'use strict';

importScripts('sql-wasm.js');

const DB_KEY = 'tabsql_db_v1';

const DEFAULT_QUICK_QUERIES = [
  { label: 'Node counts',    sql: `SELECT node_type, COUNT(*) c FROM node GROUP BY node_type ORDER BY c DESC` },
  { label: 'Open tabs',      sql: `SELECT * FROM node WHERE is_open=1 AND node_type='tab' ORDER BY position` },
  { label: 'Saved tabs',     sql: `SELECT * FROM node WHERE node_type='tab' AND is_saved=1 ORDER BY updated_at DESC LIMIT 100` },
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
      is_saved       INTEGER NOT NULL DEFAULT 0,
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
    DROP VIEW IF EXISTS tab_flat;
    DROP VIEW IF EXISTS window_summary;
    CREATE VIEW tab_flat AS
      SELECT n.id, n.node_type, n.title, n.url, n.favicon_url,
             n.is_open, n.is_saved, n.is_collapsed, n.position,
             n.custom_title, n.color_active, n.color_saved,
             p.id AS parent_id, p.title AS parent_title, p.node_type AS parent_type,
             n.created_at, n.updated_at
      FROM node n LEFT JOIN node p ON n.parent_id = p.id
      WHERE n.node_type = 'tab';
    CREATE VIEW window_summary AS
      SELECT w.id, w.node_type,
             COALESCE(w.custom_title, w.title, 'Untitled') AS title,
             w.is_open, w.is_saved, w.is_collapsed, w.win_rect, w.custom_favicon,
             COUNT(t.id) AS tab_count, SUM(t.is_open) AS open_tab_count
      FROM node w
      LEFT JOIN node t ON t.parent_id = w.id AND t.node_type = 'tab'
      WHERE w.node_type = 'win'
      GROUP BY w.id;
    CREATE TABLE IF NOT EXISTS quick_query (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      label      TEXT    NOT NULL,
      sql        TEXT    NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_qquery_pos ON quick_query (position);
    CREATE TABLE IF NOT EXISTS tag (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#7c9ef8'
    );
    CREATE TABLE IF NOT EXISTS node_tag (
      node_id INTEGER NOT NULL,
      tag_id  INTEGER NOT NULL,
      PRIMARY KEY (node_id, tag_id)
    );
    CREATE TABLE IF NOT EXISTS win_auto_tag (
      win_node_id INTEGER NOT NULL,
      tag_id      INTEGER NOT NULL,
      PRIMARY KEY (win_node_id, tag_id)
    );
    CREATE TABLE IF NOT EXISTS action_rule (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      action_type    TEXT NOT NULL,
      condition_type TEXT NOT NULL,
      condition      TEXT NOT NULL,
      config         TEXT,
      is_auto        INTEGER NOT NULL DEFAULT 0,
      position       INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Migrate: add domain column to existing DBs
  try { db.exec('ALTER TABLE node ADD COLUMN domain TEXT'); } catch {}
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_chrome_uniq ON node (chrome_id)'); } catch {}
  // Migrate: add is_saved column and convert old savedtab/savedwin node_type values
  try { db.exec('ALTER TABLE node ADD COLUMN is_saved INTEGER NOT NULL DEFAULT 0'); } catch {}
  db.exec("UPDATE node SET node_type='tab', is_saved=1 WHERE node_type='savedtab'");
  db.exec("UPDATE node SET node_type='win', is_saved=1 WHERE node_type='savedwin'");
  // Populate domain for nodes that have a url but no domain yet
  const needsDomain = sqlQuery('SELECT id, url FROM node WHERE url IS NOT NULL AND (domain IS NULL OR domain = "")');
  for (const n of needsDomain) {
    const d = extractDomain(n.url);
    if (d) sqlRun('UPDATE node SET domain=? WHERE id=?', [d, n.id]);
  }
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

function extractDomain(url) {
  if (!url) return null;
  try { return new URL(url).hostname || null; } catch { return null; }
}

// Parse "field:value plain terms" into [{field, value}]
function parseSearchTerms(q) {
  const terms = [];
  const re = /(\w+):(\S+)|(\S+)/g;
  let m;
  while ((m = re.exec(q)) !== null) {
    if (m[1]) terms.push({ field: m[1].toLowerCase(), value: m[2].toLowerCase() });
    else      terms.push({ field: null,                value: m[3].toLowerCase() });
  }
  return terms;
}

function buildSearchWhere(terms) {
  const clauses = [], params = [];
  for (const t of terms) {
    const like = `%${t.value}%`;
    if (!t.field) {
      clauses.push('(title LIKE ? OR url LIKE ? OR note_text LIKE ? OR custom_title LIKE ?)');
      params.push(like, like, like, like);
    } else if (t.field === 'title') {
      clauses.push('title LIKE ?'); params.push(like);
    } else if (t.field === 'url') {
      clauses.push('url LIKE ?'); params.push(like);
    } else if (t.field === 'domain') {
      clauses.push('domain LIKE ?'); params.push(like);
    } else if (t.field === 'note') {
      clauses.push('note_text LIKE ?'); params.push(like);
    } else if (t.field === 'label') {
      clauses.push('(COALESCE(custom_title, title, url, note_text) LIKE ?)'); params.push(like);
    } else if (t.field === 'tag') {
      clauses.push('id IN (SELECT nt.node_id FROM node_tag nt JOIN tag t2 ON t2.id=nt.tag_id WHERE t2.name LIKE ?)');
      params.push(like);
    } else {
      clauses.push('(title LIKE ? OR url LIKE ? OR note_text LIKE ? OR custom_title LIKE ?)');
      params.push(like, like, like, like);
    }
  }
  return { where: clauses.length ? clauses.join(' AND ') : '1=1', params };
}

// ---------------------------------------------------------------------------
// Node operations
// ---------------------------------------------------------------------------

function upsertNode(node) {
  if ('url' in node && !('domain' in node)) {
    node = { ...node, domain: extractDomain(node.url) };
  }
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
// Message handler (used by sidebar and event helpers)
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
      toDelete.forEach(id => {
        sqlRun('DELETE FROM node_tag WHERE node_id=?', [id]);
        sqlRun('DELETE FROM win_auto_tag WHERE win_node_id=?', [id]);
        sqlRun('DELETE FROM node WHERE id=?', [id]);
      });
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
      const terms = parseSearchTerms(payload.q.toLowerCase());
      const { where, params } = buildSearchWhere(terms);
      const rows = sqlQuery(`SELECT * FROM node WHERE ${where} LIMIT 200`, params);
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
        `SELECT id, url, position FROM node WHERE parent_id=? AND node_type='tab' AND is_saved=1 AND url IS NOT NULL ORDER BY position`,
        [payload.winNodeId]
      );
      if (!savedTabs.length) return { ok: true };
      const newWin = await chrome.windows.create({ url: savedTabs.map(t => t.url) });
      // Update the saved win node back to an open win
      upsertNode({ id: payload.winNodeId, node_type: 'win', is_open: 1, is_saved: 0, chrome_id: newWin.id });
      // Match created tabs 1:1 to saved nodes and mark them so onTabCreated skips them
      const chromeTabs = newWin.tabs ?? [];
      for (let i = 0; i < Math.min(savedTabs.length, chromeTabs.length); i++) {
        upsertNode({ id: savedTabs[i].id, chrome_id: chromeTabs[i].id, is_open: 1, is_saved: 0, node_type: 'tab', position: i });
        adoptedTabIds.add(chromeTabs[i].id);
      }
      await persistDb();
      return { ok: true };
    }

    case 'save_window': {
      const openTabs = sqlQuery(
        `SELECT id, chrome_id FROM node WHERE parent_id=? AND node_type='tab' AND is_saved=0`,
        [payload.winNodeId]
      );
      for (const t of openTabs) {
        sqlRun(`UPDATE node SET is_saved=1, updated_at=datetime('now') WHERE id=?`, [t.id]);
      }
      await persistDb();
      const winRow = sqlQuery('SELECT chrome_id FROM node WHERE id=?', [payload.winNodeId])[0];
      if (winRow?.chrome_id) { try { await chrome.windows.remove(winRow.chrome_id); } catch {} }
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

    // ── Tags ──────────────────────────────────────────────────────────────────
    case 'get_tags':
      return { ok: true, rows: sqlQuery('SELECT * FROM tag ORDER BY name') };

    case 'save_tag': {
      const { id: tid, name: tname, color: tcolor } = payload;
      if (tid) {
        sqlRun('UPDATE tag SET name=?, color=? WHERE id=?', [tname, tcolor, tid]);
        await persistDb();
        return { ok: true, id: tid };
      }
      const newId = sqlInsert('INSERT INTO tag (name, color) VALUES (?,?)', [tname, tcolor]);
      await persistDb();
      return { ok: true, id: newId };
    }

    case 'delete_tag': {
      sqlRun('DELETE FROM node_tag WHERE tag_id=?', [payload.id]);
      sqlRun('DELETE FROM win_auto_tag WHERE tag_id=?', [payload.id]);
      sqlRun('DELETE FROM tag WHERE id=?', [payload.id]);
      await persistDb();
      return { ok: true };
    }

    case 'get_node_tags': {
      const rows = sqlQuery(
        'SELECT t.* FROM tag t JOIN node_tag nt ON t.id=nt.tag_id WHERE nt.node_id=?',
        [payload.nodeId]
      );
      return { ok: true, rows };
    }

    case 'get_all_node_tags': {
      const rows = sqlQuery('SELECT nt.node_id, t.id, t.name, t.color FROM node_tag nt JOIN tag t ON t.id=nt.tag_id');
      return { ok: true, rows };
    }

    case 'set_node_tags': {
      sqlRun('DELETE FROM node_tag WHERE node_id=?', [payload.nodeId]);
      for (const tid of (payload.tagIds ?? [])) {
        sqlRun('INSERT OR IGNORE INTO node_tag (node_id, tag_id) VALUES (?,?)', [payload.nodeId, tid]);
      }
      await persistDb();
      return { ok: true };
    }

    case 'get_win_auto_tags': {
      const rows = sqlQuery(
        'SELECT t.* FROM tag t JOIN win_auto_tag wat ON t.id=wat.tag_id WHERE wat.win_node_id=?',
        [payload.winNodeId]
      );
      return { ok: true, rows };
    }

    case 'set_win_auto_tag': {
      if (payload.enabled) {
        sqlRun('INSERT OR IGNORE INTO win_auto_tag (win_node_id, tag_id) VALUES (?,?)', [payload.winNodeId, payload.tagId]);
      } else {
        sqlRun('DELETE FROM win_auto_tag WHERE win_node_id=? AND tag_id=?', [payload.winNodeId, payload.tagId]);
      }
      await persistDb();
      return { ok: true };
    }

    case 'tag_search_results': {
      const terms = parseSearchTerms((payload.q ?? '').toLowerCase());
      const { where, params } = buildSearchWhere(terms);
      const matched = sqlQuery(`SELECT id, node_type FROM node WHERE ${where} LIMIT 1000`, params);
      for (const n of matched) {
        sqlRun('INSERT OR IGNORE INTO node_tag (node_id, tag_id) VALUES (?,?)', [n.id, payload.tagId]);
        if (n.node_type === 'win') {
          sqlRun('INSERT OR IGNORE INTO win_auto_tag (win_node_id, tag_id) VALUES (?,?)', [n.id, payload.tagId]);
          const kids = sqlQuery('SELECT id FROM node WHERE parent_id=?', [n.id]);
          for (const k of kids) {
            sqlRun('INSERT OR IGNORE INTO node_tag (node_id, tag_id) VALUES (?,?)', [k.id, payload.tagId]);
          }
        }
      }
      await persistDb();
      return { ok: true, count: matched.length };
    }

    // ── Action rules ─────────────────────────────────────────────────────────
    case 'get_action_rules':
      return { ok: true, rows: sqlQuery('SELECT * FROM action_rule ORDER BY position, id') };

    case 'save_action_rule': {
      const { id: aid, name: aname, action_type, condition_type, condition, config, is_auto, position: apos } = payload;
      if (aid) {
        sqlRun(
          'UPDATE action_rule SET name=?, action_type=?, condition_type=?, condition=?, config=?, is_auto=? WHERE id=?',
          [aname, action_type, condition_type, condition, config ?? null, is_auto ? 1 : 0, aid]
        );
        await persistDb();
        return { ok: true, id: aid };
      }
      const maxPos = sqlQuery('SELECT MAX(position) m FROM action_rule')[0]?.m ?? -1;
      const newId = sqlInsert(
        'INSERT INTO action_rule (name, action_type, condition_type, condition, config, is_auto, position) VALUES (?,?,?,?,?,?,?)',
        [aname, action_type, condition_type, condition, config ?? null, is_auto ? 1 : 0, (apos ?? maxPos + 1)]
      );
      await persistDb();
      return { ok: true, id: newId };
    }

    case 'delete_action_rule':
      sqlRun('DELETE FROM action_rule WHERE id=?', [payload.id]);
      await persistDb();
      return { ok: true };

    case 'run_action_rule': {
      const rule = sqlQuery('SELECT * FROM action_rule WHERE id=?', [payload.id])[0];
      if (!rule) return { ok: false, error: 'Rule not found' };
      const affected = await executeActionRule(rule);
      return { ok: true, affected };
    }

    case 'run_auto_actions': {
      const rules = sqlQuery('SELECT * FROM action_rule WHERE is_auto=1');
      let total = 0;
      for (const rule of rules) total += await executeActionRule(rule);
      if (total > 0) await persistDb();
      return { ok: true, total };
    }

    case 'open_search_in_window': {
      const terms = parseSearchTerms((payload.q ?? '').toLowerCase());
      const { where, params } = buildSearchWhere(terms);
      const tabs = sqlQuery(
        `SELECT id, url, is_open, chrome_id, is_saved FROM node WHERE (${where}) AND node_type='tab' AND url IS NOT NULL AND id NOT IN (SELECT DISTINCT parent_id FROM node WHERE parent_id IS NOT NULL) LIMIT 50`,
        params
      );
      if (!tabs.length) return { ok: true, moved: 0 };

      const openTabs  = tabs.filter(t => t.is_open && t.chrome_id);
      const savedTabs = tabs.filter(t => !t.is_open || !t.chrome_id);

      let newWin;
      if (openTabs.length) {
        newWin = await chrome.windows.create({ tabId: openTabs[0].chrome_id });
        for (let i = 1; i < openTabs.length; i++) {
          await chrome.tabs.move(openTabs[i].chrome_id, { windowId: newWin.id, index: -1 });
        }
      } else {
        newWin = await chrome.windows.create({ url: savedTabs[0].url });
        adoptedTabIds.add(newWin.tabs[0].id);
      }

      let winNodeId = sqlQuery(`SELECT id FROM node WHERE chrome_id=? AND node_type='win' LIMIT 1`, [newWin.id])[0]?.id;
      if (!winNodeId) {
        winNodeId = upsertNode({
          node_type: 'win', is_open: 1, is_saved: 0, chrome_id: newWin.id,
          win_rect: `${newWin.left}_${newWin.top}_${newWin.width}_${newWin.height}`,
          relicons: newWin.type ?? 'normal',
        });
      }

      let pos = 0;
      for (const t of openTabs) {
        upsertNode({ id: t.id, parent_id: winNodeId, position: pos++ });
      }
      if (openTabs.length === 0 && savedTabs.length) {
        upsertNode({ id: savedTabs[0].id, chrome_id: newWin.tabs[0].id, is_open: 1, is_saved: 0, parent_id: winNodeId, position: pos++ });
        for (let i = 1; i < savedTabs.length; i++) {
          const newTab = await chrome.tabs.create({ windowId: newWin.id, url: savedTabs[i].url, active: false });
          adoptedTabIds.add(newTab.id);
          upsertNode({ id: savedTabs[i].id, chrome_id: newTab.id, is_open: 1, is_saved: 0, parent_id: winNodeId, position: pos++ });
        }
      } else {
        for (const t of savedTabs) {
          const newTab = await chrome.tabs.create({ windowId: newWin.id, url: t.url, active: false });
          adoptedTabIds.add(newTab.id);
          upsertNode({ id: t.id, chrome_id: newTab.id, is_open: 1, is_saved: 0, parent_id: winNodeId, position: pos++ });
        }
      }

      await persistDb();
      return { ok: true, moved: tabs.length };
    }

    case 'save_close_search': {
      const terms = parseSearchTerms((payload.q ?? '').toLowerCase());
      const { where, params } = buildSearchWhere(terms);
      const tabs = sqlQuery(
        `SELECT id, chrome_id, is_open FROM node WHERE (${where}) AND node_type='tab' AND url IS NOT NULL AND id NOT IN (SELECT DISTINCT parent_id FROM node WHERE parent_id IS NOT NULL) LIMIT 200`,
        params
      );
      let count = 0;
      for (const t of tabs) {
        sqlRun(`UPDATE node SET is_saved=1, is_open=0, chrome_id=NULL, updated_at=datetime('now') WHERE id=?`, [t.id]);
        if (t.is_open && t.chrome_id) { try { await chrome.tabs.remove(t.chrome_id); } catch {} }
        count++;
      }
      await persistDb();
      return { ok: true, count };
    }

    case 'close_search': {
      const terms = parseSearchTerms((payload.q ?? '').toLowerCase());
      const { where, params } = buildSearchWhere(terms);
      const tabs = sqlQuery(
        `SELECT id, chrome_id FROM node WHERE (${where}) AND node_type='tab' AND is_open=1 AND url IS NOT NULL AND id NOT IN (SELECT DISTINCT parent_id FROM node WHERE parent_id IS NOT NULL) LIMIT 200`,
        params
      );
      let count = 0;
      for (const t of tabs) {
        if (t.chrome_id) { try { await chrome.tabs.remove(t.chrome_id); } catch {} }
        count++;
      }
      return { ok: true, count };
    }

    // ── Schema info ──────────────────────────────────────────────────────────
    case 'get_schema': {
      const tables = sqlQuery("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
      const views  = sqlQuery("SELECT name FROM sqlite_master WHERE type='view'  ORDER BY name");
      const result = {};
      for (const t of [...tables, ...views]) {
        try {
          result[t.name] = sqlQuery(`PRAGMA table_info(${t.name})`);
        } catch {}
      }
      return { ok: true, schema: result };
    }

    case 'resync':
      await resync();
      return { ok: true };

    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

async function executeActionRule(rule) {
  let nodes = [];
  if (rule.condition_type === 'search') {
    const terms = parseSearchTerms((rule.condition ?? '').toLowerCase());
    const { where, params } = buildSearchWhere(terms);
    nodes = sqlQuery(`SELECT * FROM node WHERE ${where} LIMIT 1000`, params);
  } else {
    try { nodes = sqlQuery(rule.condition); } catch { return 0; }
  }

  const cfg = rule.config ? JSON.parse(rule.config) : {};
  let count = 0;

  if (rule.action_type === 'add_tag' && cfg.tag_id) {
    for (const n of nodes) {
      sqlRun('INSERT OR IGNORE INTO node_tag (node_id, tag_id) VALUES (?,?)', [n.id, cfg.tag_id]);
      count++;
    }
  } else if (rule.action_type === 'delete') {
    const delayDays = +(cfg.delay_days ?? 0);
    for (const n of nodes) {
      if (delayDays > 0) {
        const rows = sqlQuery(
          `SELECT id FROM node WHERE id=? AND updated_at <= datetime('now', '-${delayDays} days')`,
          [n.id]
        );
        if (!rows.length) continue;
      }
      sqlRun('DELETE FROM node_tag WHERE node_id=?', [n.id]);
      sqlRun('DELETE FROM win_auto_tag WHERE win_node_id=?', [n.id]);
      sqlRun('DELETE FROM node WHERE id=?', [n.id]);
      count++;
    }
  } else if (rule.action_type === 'move' && cfg.target_win_id) {
    const kids = sqlQuery('SELECT COUNT(*) c FROM node WHERE parent_id=?', [cfg.target_win_id]);
    let pos = kids[0]?.c ?? 0;
    for (const n of nodes) {
      if (n.node_type === 'tab') {
        sqlRun(`UPDATE node SET parent_id=?, position=?, updated_at=datetime('now') WHERE id=?`,
               [cfg.target_win_id, pos++, n.id]);
        count++;
      }
    }
  } else if (rule.action_type === 'save_on_close') {
    for (const n of nodes) {
      if (n.node_type === 'tab' && n.is_open && !n.is_saved) {
        sqlRun(`UPDATE node SET is_saved=1, is_open=0, chrome_id=NULL, updated_at=datetime('now') WHERE id=?`, [n.id]);
        if (n.chrome_id) { try { await chrome.tabs.remove(n.chrome_id); } catch {} }
        count++;
      }
    }
  }
  await persistDb();
  return count;
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
    `SELECT id FROM node WHERE chrome_id=? AND node_type='win' LIMIT 1`,
    [chromeWin.id]
  )[0];
  const node = {
    node_type: 'win',
    is_open:   1,
    is_saved:  0,
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
    `SELECT id FROM node WHERE chrome_id=? AND node_type='tab' LIMIT 1`,
    [chromeTab.id]
  )[0];
  const node = {
    node_type:   'tab',
    is_open:     1,
    is_saved:    0,
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
    `SELECT id FROM node WHERE node_type='win' AND chrome_id=? LIMIT 1`,
    [chromeWinId]
  );
  return rows[0]?.id ?? null;
}

async function tabDbId(chromeTabId) {
  await ensureDb();
  const rows = sqlQuery(
    `SELECT id FROM node WHERE node_type='tab' AND chrome_id=? LIMIT 1`,
    [chromeTabId]
  );
  return rows[0]?.id ?? null;
}

async function resync() {
  await ensureDb();
  const wins = await chrome.windows.getAll({ populate: true });

  const currentWinIds = new Set(wins.map(w => w.id));
  const currentTabIds = new Set();
  for (const w of wins) for (const t of (w.tabs ?? [])) currentTabIds.add(t.id);

  for (const win of wins) {
    const existingWin = sqlQuery(
      `SELECT id FROM node WHERE chrome_id=? AND node_type='win' LIMIT 1`,
      [win.id]
    )[0];
    const winNode = {
      node_type: 'win', is_open: 1, is_saved: 0, chrome_id: win.id,
      win_rect: `${win.left}_${win.top}_${win.width}_${win.height}`,
      relicons:  win.type ?? 'normal',
    };
    if (existingWin) winNode.id = existingWin.id;
    const wid = upsertNode(winNode);

    for (const tab of (win.tabs ?? [])) {
      const existingTab = sqlQuery(
        `SELECT id FROM node WHERE chrome_id=? AND node_type='tab' LIMIT 1`,
        [tab.id]
      )[0];
      const tabNode = {
        node_type: 'tab', is_open: 1, is_saved: 0, chrome_id: tab.id,
        title: tab.title ?? '', url: tab.url ?? '', favicon_url: tab.favIconUrl ?? '',
        position: tab.index ?? 0,
      };
      if (existingTab) {
        tabNode.id = existingTab.id;
      } else {
        tabNode.parent_id = wid;
      }
      upsertNode(tabNode);
    }
  }

  // Mark stale open tabs as saved
  const staleTabs = sqlQuery(
    `SELECT id, chrome_id FROM node WHERE node_type='tab' AND is_open=1 AND chrome_id IS NOT NULL`
  );
  for (const row of staleTabs) {
    if (!currentTabIds.has(row.chrome_id)) {
      sqlRun(
        `UPDATE node SET is_saved=1, is_open=0, chrome_id=NULL, updated_at=datetime('now') WHERE id=?`,
        [row.id]
      );
    }
  }

  // Mark stale open windows as saved (or delete if no saved content)
  const staleWins = sqlQuery(
    `SELECT id, chrome_id FROM node WHERE node_type='win' AND is_open=1 AND chrome_id IS NOT NULL`
  );
  for (const row of staleWins) {
    if (!currentWinIds.has(row.chrome_id)) {
      deleteOpenDescendants(row.id, null);
      if (hasSavedDescendants(row.id)) {
        sqlRun(
          `UPDATE node SET is_saved=1, is_open=0, chrome_id=NULL, updated_at=datetime('now') WHERE id=?`,
          [row.id]
        );
      } else {
        sqlRun('DELETE FROM node WHERE id=?', [row.id]);
      }
    }
  }

  await persistDb();
}

async function initialize() {
  await resync();
  console.log('TabSQL initialized');
}

// ---------------------------------------------------------------------------
// Chrome event handlers
// ---------------------------------------------------------------------------

// Returns true if nodeId has any saved descendant at any depth
function hasSavedDescendants(nodeId) {
  const children = sqlQuery('SELECT id, is_saved FROM node WHERE parent_id=?', [nodeId]);
  for (const child of children) {
    if (child.is_saved) return true;
    if (hasSavedDescendants(child.id)) return true;
  }
  return false;
}

// Delete open tab descendants, re-parenting any saved tab children up the tree
function deleteOpenDescendants(nodeId, newParentId) {
  const children = sqlQuery('SELECT id, node_type, is_saved FROM node WHERE parent_id=?', [nodeId]);
  for (const child of children) {
    if (child.is_saved) {
      sqlRun(`UPDATE node SET parent_id=? WHERE id=?`, [newParentId, child.id]);
    } else if (child.node_type === 'tab' && !child.is_saved) {
      deleteOpenDescendants(child.id, newParentId ?? nodeId);
      sqlRun('DELETE FROM node WHERE id=?', [child.id]);
    }
  }
}

async function onWindowCreated(win) { await upsertWin(win); }

async function onWindowRemoved(winId) {
  await ensureDb();
  const { popupWinId } = await chrome.storage.session.get('popupWinId');
  if (winId === popupWinId) {
    await chrome.storage.session.remove('popupWinId');
    return;
  }
  const winRow = sqlQuery(`SELECT id FROM node WHERE node_type='win' AND chrome_id=? LIMIT 1`, [winId])[0];
  if (!winRow) return;
  deleteOpenDescendants(winRow.id, null);
  if (hasSavedDescendants(winRow.id)) {
    sqlRun(`UPDATE node SET is_saved=1, is_open=0, chrome_id=NULL, updated_at=datetime('now') WHERE id=?`, [winRow.id]);
  } else {
    sqlRun('DELETE FROM node WHERE id=?', [winRow.id]);
  }
  await persistDb();
}

async function onTabCreated(tab) {
  if (adoptedTabIds.has(tab.id)) {
    adoptedTabIds.delete(tab.id);
    return;
  }

  if (pendingAdopt && (Date.now() - pendingAdopt.ts < 5000)) {
    const { nodeId } = pendingAdopt;
    pendingAdopt = null;
    const savedPos = sqlQuery('SELECT position FROM node WHERE id=?', [nodeId])[0]?.position ?? -1;
    const pid = await winDbId(tab.windowId);
    upsertNode({
      id:          nodeId,
      chrome_id:   tab.id,
      is_open:     1,
      is_saved:    0,
      node_type:   'tab',
      parent_id:   pid,
      title:       tab.title      ?? '',
      url:         tab.url        ?? '',
      favicon_url: tab.favIconUrl ?? '',
      position:    tab.index      ?? 0,
    });
    await persistDb();
    if (savedPos >= 0 && savedPos !== tab.index) {
      try { await chrome.tabs.move(tab.id, { index: savedPos }); } catch {}
    }
    return;
  }

  let pid = null;
  if (tab.openerTabId) pid = await tabDbId(tab.openerTabId);
  if (pid == null)     pid = await winDbId(tab.windowId);
  const newTabId = await upsertTab(tab, pid);
  const winId = await winDbId(tab.windowId);
  if (winId) {
    const autoTags = sqlQuery('SELECT tag_id FROM win_auto_tag WHERE win_node_id=?', [winId]);
    for (const at of autoTags) {
      sqlRun('INSERT OR IGNORE INTO node_tag (node_id, tag_id) VALUES (?,?)', [newTabId, at.tag_id]);
    }
    if (autoTags.length) await persistDb();
  }
}

async function onTabRemoved(tabId, _info) {
  await ensureDb();
  const row = sqlQuery(`SELECT * FROM node WHERE node_type='tab' AND chrome_id=? LIMIT 1`, [tabId])[0];
  if (!row) return;

  const saveRules = sqlQuery(`SELECT * FROM action_rule WHERE action_type='save_on_close' AND is_auto=1`);
  let shouldSave = false;
  for (const rule of saveRules) {
    if (rule.condition_type === 'search') {
      const terms = parseSearchTerms((rule.condition ?? '').toLowerCase());
      const { where, params } = buildSearchWhere(terms);
      const match = sqlQuery(`SELECT id FROM node WHERE id=? AND (${where})`, [row.id, ...params]);
      if (match.length) { shouldSave = true; break; }
    } else if (rule.condition_type === 'sql') {
      try {
        const result = sqlQuery(rule.condition);
        if (result.some(r => r.id === row.id)) { shouldSave = true; break; }
      } catch {}
    }
  }

  if (shouldSave) {
    sqlRun(`UPDATE node SET is_saved=1, is_open=0, chrome_id=NULL, updated_at=datetime('now') WHERE id=?`, [row.id]);
  } else {
    sqlRun(`UPDATE node SET parent_id=? WHERE parent_id=? AND node_type='tab' AND is_saved=1`, [row.parent_id, row.id]);
    sqlRun('DELETE FROM node WHERE id=?', [row.id]);
  }
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
// UI — popup lifecycle
// ---------------------------------------------------------------------------

async function openOrFocusPopup() {
  const { popupWinId } = await chrome.storage.session.get('popupWinId');
  if (popupWinId != null) {
    try {
      await chrome.windows.update(popupWinId, { focused: true });
      return;
    } catch {} // window was closed
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('index.html'),
    type: 'popup', width: 400, height: 800,
  });
  await chrome.storage.session.set({ popupWinId: win.id });
}

chrome.action.onClicked.addListener(() => {
  openOrFocusPopup().catch(e => console.error('openPopup:', e));
});
chrome.commands.onCommand.addListener(cmd => {
  if (cmd === 'open_sidebar') openOrFocusPopup().catch(console.error);
});

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason !== 'update') return;
  chrome.storage.session.get('popupWinId').then(async ({ popupWinId }) => {
    if (popupWinId == null) return;
    try { await chrome.windows.remove(popupWinId); } catch {}
    await chrome.storage.session.remove('popupWinId');
    await openOrFocusPopup();
  }).catch(console.error);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

initialize().catch(e => console.error('TabSQL boot error:', e));
