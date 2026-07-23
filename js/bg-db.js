import { parseSearchTerms } from './common.js';
import { initSqlJs } from '../sql-wasm.js';

export const DEFAULT_QUICK_QUERIES = [
  { label: 'Node counts',    sql: `SELECT node_type, COUNT(*) c FROM node GROUP BY node_type ORDER BY c DESC` },
  { label: 'Open tabs',      sql: `SELECT * FROM node WHERE is_open=1 AND node_type='tab' ORDER BY position` },
  { label: 'Saved tabs',     sql: `SELECT * FROM node WHERE node_type='tab' AND is_saved=1 ORDER BY updated_at DESC LIMIT 100` },
  { label: 'Window summary', sql: `SELECT * FROM window_summary ORDER BY tab_count DESC` },
  { label: 'Tab flat view',  sql: `SELECT * FROM tab_flat LIMIT 100` },
  { label: 'Node tree',      sql: `SELECT id, node_type, title, level, win_node_id, group_node_id FROM node_tree WHERE is_open=1 ORDER BY win_node_id NULLS FIRST, level, order_by LIMIT 200` },
  { label: 'Duplicate URLs', sql: `SELECT url, COUNT(*) c FROM node WHERE url IS NOT NULL GROUP BY url HAVING c>1 ORDER BY c DESC` },
  { label: 'Recently added', sql: `SELECT * FROM node ORDER BY created_at DESC LIMIT 50` },
  { label: 'All notes',      sql: `SELECT * FROM node WHERE note_text IS NOT NULL ORDER BY updated_at DESC` },
];

// Shared mutable state accessed by both bg-db.js internals and bg-sync.js / background.js
export const bgState = {
  pendingAdopt:  null,
  adoptedTabIds: new Set(),
  movingTabIds:  new Map(), // chromeTabId → timestamp; 5s TTL prevents cascade re-entry
};

let SQL     = null;
let db      = null;
let dbReady = null;

async function _initDb() {
  SQL = await initSqlJs({ locateFile: () => chrome.runtime.getURL('sql-wasm.wasm') });
  const stored = await chrome.storage.local.get('tabsql_db_v1');
  if (stored['tabsql_db_v1']) {
    db = new SQL.Database(new Uint8Array(stored['tabsql_db_v1']));
  } else {
    db = new SQL.Database();
  }
  applySchema();
}

export async function ensureDb() {
  if (db) return;
  if (!dbReady) dbReady = _initDb();
  await dbReady;
}

export async function persistDb() {
  if (!db) return;
  const data = db.export();
  await chrome.storage.local.set({ tabsql_db_v1: Array.from(data) });
}

export function sqlQuery(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

export function sqlRun(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.run(params);
  stmt.free();
}

export function sqlInsert(sql, params = []) {
  sqlRun(sql, params);
  return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
}

export function sqlExec(sql) {
  db.exec(sql);
}

export function extractDomain(url) {
  if (!url) return null;
  try { return new URL(url).hostname || null; } catch { return null; }
}

export function buildSearchWhere(q) {
  const terms = parseSearchTerms(q);
  const clauses = [], params = [];
  for (const t of terms) {
    const like = `%${t.value}%`;
    switch (t.field) {
      case 'title':
      case 'url':
      case 'domain':
        clauses.push(t.field + ' LIKE ?'); params.push(like); break;
      case 'note':
      case 'note_text':
        clauses.push('note_text LIKE ?'); params.push(like); break;
      case 'label':
      case 'tag':
        clauses.push('id IN (SELECT nt.node_id FROM node_tag nt JOIN tag t2 ON t2.id=nt.tag_id WHERE t2.name LIKE ?)');
        params.push(like); break;
      default:
        clauses.push('(title LIKE ? OR url LIKE ? OR note_text LIKE ?)');
        params.push(like, like, like);
    }
  }
  return { where: clauses.length ? clauses.join(' AND ') : '1=1', params };
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
    CREATE INDEX IF NOT EXISTS idx_parent ON node (parent_id, position);
    CREATE INDEX IF NOT EXISTS idx_chrome ON node (chrome_id);
    CREATE INDEX IF NOT EXISTS idx_type   ON node (node_type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chrome_type_uniq ON node (node_type, chrome_id) WHERE chrome_id IS NOT NULL;
    DROP VIEW IF EXISTS tab_flat;
    DROP VIEW IF EXISTS window_summary;
    DROP VIEW IF EXISTS node_tree;
    CREATE VIEW node_tree AS
      WITH RECURSIVE tree(id, node_type, level, win_node_id, group_node_id) AS (
        SELECT id, node_type, 1, NULL, NULL
        FROM node WHERE parent_id IS NULL
        UNION ALL
        SELECT n.id, n.node_type,
               t.level + 1,
               CASE WHEN t.node_type = 'win' THEN t.id ELSE t.win_node_id END,
               CASE WHEN t.node_type = 'group' THEN t.id ELSE t.group_node_id END
        FROM node n JOIN tree t ON n.parent_id = t.id
      )
      SELECT n.*, t.level, t.win_node_id, t.group_node_id
      FROM node n JOIN tree t ON n.id = t.id;
    CREATE VIEW tab_flat AS
      SELECT n.id, n.node_type, n.title, n.url, n.favicon_url,
             n.is_open, n.is_saved, n.is_collapsed, n.position,
             n.color_active, n.color_saved,
             p.id AS parent_id, p.title AS parent_title, p.node_type AS parent_type,
             n.created_at, n.updated_at
      FROM node n LEFT JOIN node p ON n.parent_id = p.id
      WHERE n.node_type = 'tab';
    CREATE VIEW window_summary AS
      SELECT w.id, w.node_type,
             COALESCE(w.title, 'Untitled') AS title,
             w.is_open, w.is_saved, w.is_collapsed, w.win_rect,
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
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Migration: add order_by; seeds from position on first run only (try fails if column exists)
  try {
    db.exec(`ALTER TABLE node ADD COLUMN order_by INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE node SET order_by = position`);
  } catch {}

  const count = sqlQuery('SELECT COUNT(*) c FROM quick_query')[0]?.c ?? 0;
  if (+count === 0) seedDefaultQueries();
}

// Returns [{id, chrome_id}] for all open, chrome-tracked descendants in order_by order (DFS)
export function getRecursiveOpenChildren(nodeId) {
  const rows = sqlQuery(
    `SELECT id, chrome_id FROM node WHERE parent_id=? AND is_open=1 AND chrome_id IS NOT NULL ORDER BY order_by`,
    [nodeId]
  );
  const result = [];
  for (const row of rows) {
    result.push(row);
    result.push(...getRecursiveOpenChildren(row.id));
  }
  return result;
}

// Walks the parent chain to find the containing win node's chrome_id
export function getWinChromeId(nodeId) {
  const row = sqlQuery(`
    WITH RECURSIVE anc(id, node_type, chrome_id, parent_id) AS (
      SELECT id, node_type, chrome_id, parent_id FROM node WHERE id=?
      UNION ALL
      SELECT n.id, n.node_type, n.chrome_id, n.parent_id FROM node n JOIN anc ON n.id=anc.parent_id
    )
    SELECT chrome_id FROM anc WHERE node_type='win' AND chrome_id IS NOT NULL LIMIT 1
  `, [nodeId])[0];
  return row?.chrome_id ?? null;
}

export function seedDefaultQueries() {
  DEFAULT_QUICK_QUERIES.forEach((q, i) => {
    sqlInsert(
      'INSERT INTO quick_query (label, sql, position, is_default) VALUES (?,?,?,1)',
      [q.label, q.sql, i]
    );
  });
}
