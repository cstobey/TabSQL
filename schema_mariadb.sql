-- Tab Outliner clone schema - MariaDB dialect
-- Run as: mysql -u root -p taboutliner < schema_mariadb.sql

CREATE DATABASE IF NOT EXISTS taboutliner CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE taboutliner;

CREATE TABLE IF NOT EXISTS node (
    id             BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    parent_id      BIGINT       REFERENCES node(id),
    node_type      VARCHAR(16)  NOT NULL,
    position       INT          NOT NULL DEFAULT 0,
    is_collapsed   TINYINT(1)   NOT NULL DEFAULT 0,
    is_open        TINYINT(1)   NOT NULL DEFAULT 0,
    chrome_id      INT          DEFAULT NULL,
    title          TEXT,
    url            TEXT,
    favicon_url    TEXT,
    note_text      TEXT,
    custom_title   TEXT,
    custom_favicon VARCHAR(255),
    color_active   VARCHAR(64),
    color_saved    VARCHAR(64),
    relicons       JSON,
    win_rect       VARCHAR(64),
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_node_type CHECK (node_type IN
        ('session','win','savedwin','tab','savedtab','textnote','separatorline','group')),
    INDEX idx_parent   (parent_id, position),
    INDEX idx_chrome   (chrome_id),
    INDEX idx_type     (node_type),
    INDEX idx_url      (url(512))
) ENGINE=InnoDB;

-- Flat tab view (MariaDB doesn't support recursive CTEs in views pre-10.2, use simple join)
CREATE OR REPLACE VIEW tab_flat AS
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

CREATE OR REPLACE VIEW window_summary AS
SELECT
    w.id, w.node_type,
    COALESCE(w.custom_title, w.title, 'Untitled') AS title,
    w.is_open, w.is_collapsed, w.win_rect, w.custom_favicon,
    COUNT(t.id) AS tab_count,
    SUM(t.is_open) AS open_tab_count
FROM node w
LEFT JOIN node t ON t.parent_id = w.id AND t.node_type IN ('tab','savedtab')
WHERE w.node_type IN ('win','savedwin')
GROUP BY w.id;
