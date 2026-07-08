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
let dbReady     = null;
let pendingAdopt  = null;
let adoptedTabIds = new Set();

async function _initDb() {
  SQL = await initSqlJs({ locateFile: () => chrome.runtime.getURL('sql-wasm.wasm') });
  const stored = await chrome.storage.local.get(DB_KEY);
  if (stored[DB_KEY]) {
    db = new SQL.Database(new Uint8Array(stored[DB_KEY]));
  } else {
    db = new SQL.Database();
  }
  applySchema();
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
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  try { db.exec('ALTER TABLE node ADD COLUMN domain TEXT'); } catch {}
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_chrome_uniq ON node (chrome_id)'); } catch {}
  try { db.exec('ALTER TABLE node ADD COLUMN is_saved INTEGER NOT NULL DEFAULT 0'); } catch {}
  db.exec("UPDATE node SET node_type='tab', is_saved=1 WHERE node_type='savedtab'");
  db.exec("UPDATE node SET node_type='win', is_saved=1 WHERE node_type='savedwin'");
  const needsDomain = sqlQuery('SELECT id, url FROM node WHERE url IS NOT NULL AND (domain IS NULL OR domain = "")');
  for (const n of needsDomain) {
    const d = extractDomain(n.url);
    if (d) sqlRun('UPDATE node SET domain=? WHERE id=?', [d, n.id]);
  }
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
