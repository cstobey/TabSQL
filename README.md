# TabSQL

A Chrome extension that manages browser tabs in a persistent tree view, backed by an in-browser SQLite database (sql.js / WASM). No server, no native host — everything runs inside the extension.

## Features

- **Tree view** of all open windows and tabs, with drag-and-drop reorganization
- **Saved tabs** — manually save a tab (`💾`) to keep it after closing; it stays in the tree as a saved node and can be re-opened later
- **Saved windows** — when a window closes, it converts to a saved window if it has saved tab children; double-click to reopen all tabs
- **Notes** — attach a note to any node via the `✎` button; displayed inline below the node
- **SQL console** — always-visible, resizable SQL panel at the bottom; run arbitrary queries against the live database
- **Saved queries** — persist frequently-used SQL queries; restore built-in defaults at any time
- **Opener hierarchy** — tabs opened from other tabs are nested under their opener
- **Tab position sync** — tab bar position is tracked and restored when a saved tab is reopened
- **Live updates** — tree refreshes automatically as tabs are opened/closed/moved

## File structure

```
TabSQL/
  manifest.json        Chrome extension manifest (MV3)
  background.js        Service worker — all DB logic and Chrome event handling
  index.html           Sidebar UI shell and all CSS
  tree.js              Sidebar UI logic
  management_ui.html   Standalone SQL console (legacy, still functional)
  sql-wasm.js          sql.js library
  sql-wasm.wasm        SQLite compiled to WASM
```

## Setup

### 1. Load the extension

- Open `chrome://extensions`
- Enable **Developer mode** (top right)
- Click **Load unpacked** → select the `TabSQL/` folder
- Click the TabSQL icon in the toolbar to open the sidebar

The sidebar opens as a popup window. Use `Ctrl+Shift+E` to open it from the keyboard.

### 2. That's it

No server to start, no install script. The database is created automatically in `chrome.storage.local` on first run and persists across browser restarts.

## Usage

### Tree navigation

| Action | Result |
|---|---|
| Click a node | Select it |
| Click `▼ / ▶` | Collapse / expand children |
| Double-click a tab | Focus it (or reopen if saved) |
| Double-click a window | Focus it (or reopen all saved tabs) |
| Drag a node | Move it to a new parent; drag left to dedent |
| Hover a node | Reveals `✎` (edit note), `💾` (save tab), `✕` (delete) |
| Right-click | Context menu (open, copy URL/title, delete) |

### Saving tabs

Tabs are **not** saved automatically when closed — closing a tab from Chrome deletes it from the tree. To keep a tab, click `💾` first. This closes the Chrome tab and converts it to a saved node that persists in the tree.

### SQL console

The SQL panel is always visible at the bottom of the sidebar. Drag the divider to resize it. Use `Ctrl+Enter` to run a query.

The `＋` button saves the current query; `－` deletes the selected one; `↺` restores any missing built-in defaults.

### Built-in queries

| Query | What it shows |
|---|---|
| Node counts | Row counts by node_type |
| Open tabs | All currently-open tabs by position |
| Saved tabs | Recently saved tabs |
| Window summary | Windows with open/total tab counts |
| Tab flat view | Tabs joined with their parent info |
| Duplicate URLs | URLs that appear more than once |
| Recently added | 50 most recently created nodes |
| All notes | Nodes with note text |

## Useful SQL

```sql
-- Open windows with tab counts
SELECT * FROM window_summary WHERE is_open=1;

-- Find tabs on a specific domain
SELECT title, url FROM node WHERE url LIKE '%github.com%' AND is_open=1;

-- Duplicate URLs
SELECT url, COUNT(*) c FROM node
WHERE url IS NOT NULL GROUP BY url HAVING c > 1 ORDER BY c DESC;

-- Bulk retitle
UPDATE node SET custom_title = REPLACE(title, 'Old Name', 'New Name')
WHERE url LIKE '%example.com%';

-- Clean up empty saved windows
DELETE FROM node WHERE node_type='savedwin'
  AND id NOT IN (SELECT DISTINCT parent_id FROM node WHERE parent_id IS NOT NULL);

-- All nodes with notes
SELECT id, node_type, title, note_text FROM node
WHERE note_text IS NOT NULL ORDER BY updated_at DESC;
```

## Data model

All data lives in a single `node` table. Every tab, window, group, and note is a row.

```
node_type   chrome_id   is_open   meaning
─────────────────────────────────────────────────────────
win         set         1         open Chrome window
savedwin    NULL        0         closed window (has saved children)
tab         set         1         open Chrome tab
savedtab    NULL        0         saved (closed) tab
group       NULL        0         user-defined folder
textnote    NULL        0         freeform note
session     NULL        0         root container node
```

Tree structure is stored via `parent_id`. Position within a parent is stored as `position` (integer, 0-based). The `chrome_id` column maps DB nodes to live Chrome windows/tabs.
