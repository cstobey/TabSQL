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
  pendingAdopt:   null,
  pendingWinAdopt: null,     // { nodeId, ts } — next onWindowCreated adopts this node
  adoptedTabIds:  new Set(),
  movingTabIds:   new Map(), // chromeTabId → timestamp; 5s TTL prevents cascade re-entry
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
             COUNT(t.id) AS tab_count, COALESCE(SUM(t.is_open), 0) AS open_tab_count
      FROM node w
      LEFT JOIN node_tree t ON t.win_node_id = w.id AND t.node_type = 'tab'
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

  // Single session root; every other root-level node hangs under it
  db.exec(`
    INSERT INTO node (node_type, title, order_by)
    SELECT 'session', 'Session', 0 WHERE NOT EXISTS (SELECT 1 FROM node WHERE node_type='session');
    UPDATE node SET parent_id=(SELECT id FROM node WHERE node_type='session')
    WHERE parent_id IS NULL AND node_type!='session';
  `);

  const count = sqlQuery('SELECT COUNT(*) c FROM quick_query')[0]?.c ?? 0;
  if (+count === 0) seedDefaultQueries();
}

export function sessionId() {
  return sqlQuery(`SELECT id FROM node WHERE node_type='session' LIMIT 1`)[0]?.id ?? null;
}

export function rowsModified() {
  return db.getRowsModified();
}

export function cfgNum(key, def) {
  const v = sqlQuery(`SELECT value FROM config WHERE key=?`, [key])[0]?.value;
  return v != null && v !== '' && !isNaN(+v) ? +v : def;
}

// Re-pack order_by to 0..n-1 per parent (ties broken by id); pass parent ids to limit
// scope. Ranks are materialized first because an UPDATE's correlated subqueries see
// rows the same statement already modified.
export function renumberOrderBy(parentIds = null) {
  const ids = parentIds?.map(Number).filter(Number.isFinite);
  const filter = ids?.length ? `WHERE parent_id IN (${ids.join(',')})` : '';
  sqlExec(`
    DROP TABLE IF EXISTS tmp_ord;
    CREATE TEMP TABLE tmp_ord AS
      SELECT id, ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY order_by, id) - 1 rk
      FROM node ${filter};
    UPDATE node SET order_by = (SELECT rk FROM tmp_ord WHERE tmp_ord.id = node.id)
      WHERE id IN (SELECT id FROM tmp_ord);
    DROP TABLE tmp_ord;
  `);
}

// Returns [{id, chrome_id}] for all open, chrome-tracked descendants in DFS tree order
export function getRecursiveOpenChildren(nodeId) {
  return sqlQuery(`
    WITH RECURSIVE d(id, chrome_id, is_open, node_type, path) AS (
      SELECT id, chrome_id, is_open, node_type, printf('%08d', order_by) FROM node WHERE parent_id=?
      UNION ALL
      SELECT n.id, n.chrome_id, n.is_open, n.node_type, d.path || '/' || printf('%08d', n.order_by)
      FROM node n JOIN d ON n.parent_id = d.id
    )
    SELECT id, chrome_id FROM d
    WHERE is_open=1 AND chrome_id IS NOT NULL AND node_type='tab'
    ORDER BY path
  `, [nodeId]);
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
