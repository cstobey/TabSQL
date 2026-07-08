# TabSQL — AI Context

## What this is

Chrome extension (Manifest V3) that manages browser tabs in a persistent tree view backed by an in-browser SQLite database (sql.js / WASM). No native host, no server — everything runs inside the extension.

## File map

| File | Role |
|---|---|
| `background.js` | MV3 service worker. All DB operations, Chrome event listeners, message handler. |
| `tree.js` | Sidebar UI logic. Sends messages to background, renders tree, handles drag/drop, SQL panel. |
| `index.html` | Sidebar shell — all CSS lives here. |
| `manifest.json` | Extension manifest. Permissions: `tabs`, `windows`, `storage`, `unlimitedStorage`, `clipboardWrite`. |
| `sql-wasm.js` / `sql-wasm.wasm` | sql.js library — SQLite compiled to WASM. |

## DB schema

### `node` table — everything is a node

```
id            INTEGER PK AUTOINCREMENT
parent_id     INTEGER → node(id)
node_type     TEXT  -- 'win' | 'tab' | 'group' | 'textnote' | 'session' | 'separatorline'
position      INTEGER
is_collapsed  INTEGER (0/1)
is_open       INTEGER (0/1)
is_saved      INTEGER (0/1)  -- 1 = saved/closed (replaces old savedwin/savedtab node_type values)
chrome_id     INTEGER  -- Chrome window/tab ID; NULL when is_saved=1
title         TEXT
url           TEXT
domain        TEXT  -- hostname extracted from url, auto-populated by upsertNode
favicon_url   TEXT
note_text     TEXT
custom_title  TEXT
custom_favicon TEXT
color_active  TEXT
color_saved   TEXT
relicons      TEXT  -- window type: 'normal' | 'popup' | 'devtools'
win_rect      TEXT  -- "left_top_width_height"
created_at    TEXT  -- datetime('now')
updated_at    TEXT  -- datetime('now')
```

`domain` is auto-populated by `extractDomain(url)` in `upsertNode` whenever `url` is set. Migrated for existing rows in `applySchema()`.

`is_saved`: distinguishes open vs saved state without needing separate node_type values. `win + is_saved=0` = open window, `win + is_saved=1` = saved/closed window. Same for `tab`. Old `savedtab`/`savedwin` rows are auto-migrated on startup.

### Views
- `tab_flat` — all tab nodes joined with their parent info
- `window_summary` — all win nodes with tab counts

### `quick_query` table
```
id          INTEGER PK
label       TEXT
sql         TEXT
position    INTEGER
is_default  INTEGER (0/1)
```

### `tag` table
```
id    INTEGER PK AUTOINCREMENT
name  TEXT UNIQUE
color TEXT  -- CSS color string, e.g. '#7c9ef8'
```

### `node_tag` table (many-to-many)
```
node_id  INTEGER NOT NULL
tag_id   INTEGER NOT NULL
PRIMARY KEY (node_id, tag_id)
```

### `win_auto_tag` table
When a tag is registered here for a window node, `onTabCreated` automatically inserts into `node_tag` for every new tab opened in that window.
```
win_node_id  INTEGER NOT NULL
tag_id       INTEGER NOT NULL
PRIMARY KEY (win_node_id, tag_id)
```
Removing a win_auto_tag entry stops future auto-tagging but does NOT remove the tag from existing node_tag rows.

### `action_rule` table
```
id             INTEGER PK AUTOINCREMENT
name           TEXT
action_type    TEXT  -- 'add_tag' | 'delete' | 'move' | 'save_on_close'
condition_type TEXT  -- 'search' | 'sql'
condition      TEXT  -- search string or SQL SELECT
config         TEXT  -- JSON: {tag_id?, delay_days?, target_win_id?}
is_auto        INTEGER (0/1)
position       INTEGER
created_at     TEXT
```

`save_on_close`: when `is_auto=1`, any tab closed whose node matches the condition is saved (`is_saved=1`) instead of deleted. Running the rule manually saves and closes all matching open tabs.

## Node types

| Type | Meaning |
|---|---|
| `session` | Root node — single top-level container |
| `win` | Chrome window — `is_saved=0` when open (`chrome_id` set, `is_open=1`), `is_saved=1` when closed/saved |
| `tab` | Chrome tab — `is_saved=0` when open (`chrome_id` set, `is_open=1`), `is_saved=1` when saved/closed |
| `group` | User-defined folder |
| `textnote` | Freeform text note |
| `separatorline` | Visual divider |

## background.js patterns

### DB init (race-safe singleton)
```js
let dbReady = null;
async function ensureDb() {
  if (db) return;
  if (!dbReady) dbReady = _initDb();
  await dbReady;
}
```

### upsertNode — partial UPDATE when id present
```js
function upsertNode(node) {
  const cols = Object.keys(node).filter(k => k !== 'id');
  if ('id' in node) {
    // UPDATE only provided columns + updated_at
    sqlRun(`UPDATE node SET ${cols.map(c => `${c}=?`).join(', ')}, updated_at=datetime('now') WHERE id=?`,
           [...cols.map(c => node[c] ?? null), node.id]);
    return node.id;
  }
  // INSERT
}
```
Safe to call with `{ id, note_text: val }` — won't clobber other fields.

### pendingAdopt — open a saved tab without creating a duplicate node
When tree.js wants to re-open a saved tab, it calls `pre_open_tab` BEFORE `chrome.tabs.create`. `onTabCreated` then checks `pendingAdopt` (5s TTL) and updates the existing node's `chrome_id` instead of inserting a new row.

### adoptedTabIds — bulk window reopen
`open_saved_window` handler opens all tabs via `chrome.windows.create`, matches them 1:1 to saved tab nodes, and adds all Chrome tab IDs to `adoptedTabIds`. `onTabCreated` skips any ID in this set.

### chrome_id dedup in initialize()
`upsertWin` and `upsertTab` look up existing nodes by `chrome_id` first. If found, they pass `id` into `upsertNode` (UPDATE path) without changing `parent_id`. This prevents duplicates when the service worker restarts.

### save_on_close action rule
`onTabRemoved` checks `is_auto=1` rules with `action_type='save_on_close'` before deleting a tab node. If the closed tab matches any rule's condition, the node is updated to `is_saved=1, is_open=0, chrome_id=NULL` instead of being deleted.

## Message protocol (background.js ↔ tree.js)

All messages: `{ to: 'background', cmd, payload }` → response `{ ok, data }` or `{ ok: false, error }`.

| cmd | payload | returns |
|---|---|---|
| `bulk_exec` | `{ sql }` | `{ rows }` |
| `upsert_node` | `{ node }` | `{ id }` |
| `delete_node` | `{ id }` | cascade-deletes all descendants + node_tag/win_auto_tag cleanup |
| `move_node` | `{ id, parent_id, position }` | — |
| `get_node` | `{ id }` | `{ row }` |
| `search` | `{ q }` | `{ rows }` — supports field-prefix syntax |
| `pre_open_tab` | `{ nodeId, url }` | sets pendingAdopt |
| `open_saved_window` | `{ winNodeId }` | opens all saved tab children in new window, adopts existing nodes |
| `save_window` | `{ winNodeId }` | marks all open tabs as saved, then closes the Chrome window |
| `open_search_in_window` | `{ q }` | moves matching leaf tab nodes to a new window (moves open tabs via chrome.tabs.move, opens fresh for saved tabs reusing existing nodes) |
| `save_close_search` | `{ q }` | saves and closes all matching leaf tab nodes |
| `close_search` | `{ q }` | closes (discards) all matching open leaf tab nodes |
| `get_quick_queries` | — | `{ rows }` |
| `save_quick_query` | `{ id?, label, sql }` | upsert by id |
| `delete_quick_query` | `{ id }` | — |
| `seed_default_queries` | — | `{ added }` |
| `get_tags` | — | `{ rows }` |
| `save_tag` | `{ id?, name, color }` | `{ id }` |
| `delete_tag` | `{ id }` | removes from node_tag and win_auto_tag too |
| `get_node_tags` | `{ nodeId }` | `{ rows }` — tag rows for one node |
| `get_all_node_tags` | — | `{ rows }` — all node_tag rows joined with tag |
| `set_node_tags` | `{ nodeId, tagIds[] }` | replaces all tags for node |
| `get_win_auto_tags` | `{ winNodeId }` | `{ rows }` |
| `set_win_auto_tag` | `{ winNodeId, tagId, enabled }` | insert or delete win_auto_tag row |
| `tag_search_results` | `{ q, tagId }` | tags all matching nodes; adds win_auto_tag for window nodes |
| `get_action_rules` | — | `{ rows }` |
| `save_action_rule` | `{ id?, name, action_type, condition_type, condition, config, is_auto }` | `{ id }` |
| `delete_action_rule` | `{ id }` | — |
| `run_action_rule` | `{ id }` | `{ affected }` |
| `run_auto_actions` | — | `{ total }` — runs all is_auto=1 rules |
| `get_schema` | — | `{ schema }` — object keyed by table/view name, values are PRAGMA table_info rows |

## Search term parser

`parseSearchTerms(q)` in both `background.js` and `tree.js` splits a query into `[{field, value}]`. Field is null for bare terms. `buildSearchWhere(terms)` (background only) returns `{ where, params }` for a parameterized SQL WHERE clause. Supported field prefixes: `title`, `url`, `domain`, `note`, `label`, `tag`.

## tree.js key patterns

### db helper (8s timeout)
```js
const db = {
  send(cmd, payload) { /* Promise with 8s timeout */ },
  query(sql), deleteNode(id), moveNode(id, parent_id, pos), upsertNode(node), preOpenTab(nodeId, url)
};
```

### Focus highlighting
`focusState` tracks `activeTabChromeIds` (one per open window) and `focusedWinChromeId`. `syncFocusState()` polls `chrome.windows.getAll` on load and manual refresh. `chrome.tabs.onActivated` and `chrome.windows.onFocusChanged` update state surgically. `applyFocusHighlights()` adds/removes `.focus-active` class. Configurable via `--focus-bg` CSS variable.

### Duplicate URL indicator
`dupUrls` Set is computed in `load()` and after any delete. Duplicate nodes show a colored circle (`.dup-dot`) prepended before the icon, colored `--dup-url`.

### Drag-to-dedent
Mouse X position relative to tree → `hoverLevel = floor((mouseX - 4) / 16)`. If `hoverLevel < nodeLevel`, walk up ancestors `(nodeLevel - hoverLevel)` steps to find effective parent.

### Note rows
Every node emits a sibling `.note-row[data-note-for=id]` div. Hidden via `.empty` class when `note_text` is null. Edit button (`✎`) replaces it with an inline input; saves via `upsertNode({ id, note_text })`.

### Inline edit saves without full re-render
The `act-edit` handler surgically updates the note row DOM and `nodeMap[id].note_text` in place. `load()` is not called — avoids collapsing the tree.

### scheduleRefresh
Debounced `load()` call (600ms) triggered by Chrome tab/window events and after mutations.

## CSS conventions (index.html)

- CSS custom properties in `:root`: `--bg`, `--surface`, `--border`, `--accent`, `--text`, `--muted`, `--hover`, `--win-icon`, `--tab-icon`, `--focus-bg`, `--dup-url`, `--indent` (16px), `--row-h` (28px)
- `.node` rows use `padding-left: (depth * 16 + 4)px` for indentation — not nested divs
- `.actions` hidden by default, shown on `.node:hover`
- `.node.open-tab .label` → tab-icon color for open tabs
- `.node.focus-active` → focus-bg highlight for active tab in each window and the focused window node
- `#sql-resize` is a 5px drag handle between tree and SQL panel; `mousemove` on `document` adjusts `#sql-panel` height

## Coding conventions

- No comments unless the WHY is non-obvious
- No confirmation dialogs on delete
- No feature flags or backwards-compat shims
- Prefer targeted DOM mutations over full re-renders when only one node changes
- `escHtml()` is defined in tree.js

## Known constraints

- Bash sandbox is broken in this environment — use Read/Edit/Write tools directly
- sql.js WASM requires `'wasm-unsafe-eval'` in the extension's CSP (already in manifest.json)
- Service workers are terminated by Chrome when idle and restart on next event — `initialize()` must be idempotent (chrome_id dedup handles this)
- `chrome.storage.local` holds the serialized DB as a plain array; exported via `db.export()` on every write
