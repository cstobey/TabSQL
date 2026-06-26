-- TabSQL schema (Tab Outliner clone) - SQLite dialect
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS node (
    id             INTEGER      PRIMARY KEY AUTOINCREMENT,
    parent_id      INTEGER      REFERENCES node(id) ON DELETE CASCADE,
    node_type      VARCHAR(16)  NOT NULL CHECK(node_type IN
                     ('session','win','savedwin','tab','savedtab',
                      'textnote','separatorline','group')),
    position       INTEGER      NOT NULL DEFAULT 0,
    is_collapsed   INTEGER      NOT NULL DEFAULT 0,  -- BOOL as int
    is_open        INTEGER      NOT NULL DEFAULT 0,
    chrome_id      INTEGER,          -- live chrome window/tab id
    title          TEXT,
    url            TEXT,
    favicon_url    TEXT,
    note_text      TEXT,
    custom_title   TEXT,
    custom_favicon TEXT,
    color_active   VARCHAR(64),
    color_saved    VARCHAR(64),
    relicons       TEXT,             -- JSON array
    win_rect       VARCHAR(64),      -- "left_top_width_height"
    created_at     DATETIME     NOT NULL DEFAULT (datetime('now')),
    updated_at     DATETIME     NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_node_parent   ON node(parent_id, position);
CREATE INDEX IF NOT EXISTS idx_node_chrome   ON node(chrome_id) WHERE chrome_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_node_type     ON node(node_type);
CREATE INDEX IF NOT EXISTS idx_node_url      ON node(url) WHERE url IS NOT NULL;

-- Trigger to maintain updated_at
CREATE TRIGGER IF NOT EXISTS node_updated_at
AFTER UPDATE ON node
BEGIN
    UPDATE node SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Flat view: every tab/savedtab with its window ancestor
CREATE VIEW IF NOT EXISTS tab_flat AS
WITH RECURSIVE ancestors(id, parent_id, node_type, title, depth) AS (
    SELECT id, parent_id, node_type, title, 0 FROM node
    UNION ALL
    SELECT n.id, n.parent_id, n.node_type, n.title, a.depth+1
    FROM node n JOIN ancestors a ON n.id = a.parent_id
)
SELECT
    n.id, n.node_type, n.title, n.url, n.favicon_url,
    n.is_open, n.is_collapsed, n.position,
    n.custom_title, n.color_active, n.color_saved,
    p.id   AS parent_id,
    p.title AS parent_title, p.node_type AS parent_type,
    n.created_at, n.updated_at
FROM node n
LEFT JOIN node p ON n.parent_id = p.id
WHERE n.node_type IN ('tab','savedtab');

-- Window summary view
CREATE VIEW IF NOT EXISTS window_summary AS
SELECT
    w.id, w.node_type, COALESCE(w.custom_title, w.title, 'Untitled') AS title,
    w.is_open, w.is_collapsed, w.win_rect, w.custom_favicon,
    COUNT(t.id) AS tab_count,
    SUM(t.is_open) AS open_tab_count
FROM node w
LEFT JOIN node t ON t.parent_id = w.id AND t.node_type IN ('tab','savedtab')
WHERE w.node_type IN ('win','savedwin')
GROUP BY w.id;
