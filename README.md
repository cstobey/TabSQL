# TabSQL

A Chrome extension that manages browser tabs in a persistent tree view, backed by an in-browser SQLite database (sql.js / WASM). No server, no native host — everything runs inside the extension.

## Features

- **Tree view** of all open windows and tabs, with drag-and-drop reorganization
- **Saved tabs** — manually save a tab (`💾`) to keep it after closing; it stays in the tree as a saved node and can be re-opened later
- **Saved windows** — when a window closes, it converts to a saved window if it has saved tab children; double-click to reopen all tabs
- **Notes** — attach a note to any node via the `✎` button; displayed inline below the node
- **Tags** — user-defined colored labels attached to any node; assignable via right-click context menu
- **SQL console** — always-visible, resizable SQL panel at the bottom; run arbitrary queries against the live database
- **Saved queries** — persist frequently-used SQL queries; restore built-in defaults at any time
- **Field-targeted search** — `domain:github`, `title:react`, `tag:work`, `note:followup`
- **Actions** — configurable rules to add tags, delete stale tabs, or move tabs to windows; run manually or auto on a schedule
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
| Right-click | Context menu — open, copy URL/title, manage tags, delete |

### Saving tabs

Tabs are **not** saved automatically when closed — closing a tab from Chrome deletes it from the tree. To keep a tab, click `💾` first. This closes the Chrome tab and converts it to a saved node that persists in the tree.

### Search

The search box supports plain-text search across title, URL, and notes. Prefix a term with a field name to target a specific field:

| Prefix | Searches |
|---|---|
| *(none)* | title, URL, note, custom title |
| `title:` | title / custom title |
| `url:` | full URL |
| `domain:` | hostname extracted from URL |
| `note:` | note text |
| `label:` | computed display label |
| `tag:` | tag names attached to the node |

Multiple terms are ANDed: `domain:github title:issues` matches nodes on github whose title contains "issues".

When search results are shown, two toolbar buttons appear:
- **⬡** — open all found tabs in a new Chrome window
- **🏷** — apply a tag to all found nodes (windows also get auto-tagging enabled)

### Tags

Tags are colored labels stored in a separate `tag` table and linked to nodes via `node_tag`.

- **Create / edit tags**: Settings (⚙) → Tags
- **Assign / remove tags on a node**: right-click → Tags…
- **Window auto-tagging**: when assigning a tag to a window node (or via bulk tag from search), check "Auto-tag new tabs in this window" to automatically apply the tag to every new tab opened in that window. Removing the auto-tag from a window does not remove it from existing tabs.

### Actions

Actions are configurable rules (Settings → Actions) that can:

- **Add tag** — apply a tag to all matching nodes
- **Delete** — delete matching nodes, optionally only if `updated_at` is older than N days
- **Move** — move matching tab nodes under a target window node

Each action has a condition that is either a **search string** (using the same field-prefix syntax as the search box) or a **SQL SELECT** query that returns node rows.

Actions can be run manually (▶ button per action) or automatically (check "Run automatically" and use the "▶ Run auto" button, or it runs on each service worker startup).

### SQL console

The SQL panel is always visible at the bottom of the sidebar. Drag the divider to resize it. Use `Ctrl+Enter` to run a query. The `📋` button opens a schema browser showing all tables, views, and columns.

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

-- Find tabs on a specific domain (or use domain: in search)
SELECT title, url FROM node WHERE domain LIKE '%github%' AND is_open=1;

-- All tabs with a specific tag
SELECT n.title, n.url, t.name AS tag
FROM node n JOIN node_tag nt ON nt.node_id=n.id JOIN tag t ON t.id=nt.tag_id
WHERE t.name = 'work';

-- Tabs auto-tagged for a window
SELECT n.title, t.name FROM node n
JOIN win_auto_tag wat ON wat.win_node_id=n.id
JOIN tag t ON t.id=wat.tag_id;

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

All nodes live in the `node` table. Tags are in `tag` / `node_tag`. Window auto-tags in `win_auto_tag`. Automation rules in `action_rule`.

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

Tree structure is stored via `parent_id`. Position within a parent is stored as `position` (integer, 0-based). The `chrome_id` column maps DB nodes to live Chrome windows/tabs. The `domain` column stores the extracted hostname from `url` for fast domain searches.
