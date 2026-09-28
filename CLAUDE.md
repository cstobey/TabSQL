# TabSQL — AI Context

## What this is

Chrome extension (Manifest V3) that manages browser tabs in a persistent tree view backed by an in-browser SQLite database (sql.js / WASM). No native host, no server — everything runs inside the extension.

## File map

| File | Role |
|---|---|
| `background.js` | MV3 service worker entry point (ES module). Imports `js/bg-*.js` and `js/common.js`, defines `handleMessage` and the `chrome.runtime.onMessage` listener. |
| `tree.js` | Sidebar ES module entry point. Imports all `js/*.js` modules and runs the boot sequence (loadDateFormat → load, loadQuickQueries, loadTheme). |
| `index.html` | Sidebar shell — all CSS lives here. Loads `tree.js` as `type="module"`. |
| `manifest.json` | Extension manifest. Background type `"module"`. Permissions: `tabs`, `tabGroups`, `windows`, `storage`, `unlimitedStorage`, `clipboardWrite`. |
| `sql-wasm.js` / `sql-wasm.wasm` | sql.js library — SQLite compiled to WASM. Exports `initSqlJs`. |
| `js/common.js` | Shared pure logic used by both the service worker and the sidebar: `parseSearchTerms`. No DOM, Chrome API, or SQL dependencies. |
| `js/bg-db.js` | DB init, schema (`applySchema`), persistence, SQL helpers (`sqlQuery`, `sqlRun`, `sqlInsert`, `sqlExec`, `rowsModified`), `buildSearchWhere`, `renumberOrderBy`, `NEXT_ROOT_ORDER`, `cfgNum`, `getRecursiveOpenChildren`, `getWinChromeId`, `bgState`. |
| `js/bg-rules.js` | Rule engine: `executeActionRule` (batch SQL per action via `tmp_rule_match`), `applyAutoRules` (all `is_auto` rules against one node at tab add/refresh), `chromeMoveIntoWin` (chrome-move open tabs into a win node, reopening it around the first tab if closed). |
| `js/bg-sync.js` | Chrome event handlers (`onTab*`, `onWindow*`, `onTabGroup*`), `resync`, `initialize`, `adoptWindows`/`mergeWindow`/`scheduleAdoption` (restore adoption), `dedupeWindows`, `chromeReparentTab`, `cascadeChildrenToChrome`, `updateBadge`, `upsertTabGroup`. |
| `js/bg-popup.js` | `openOrFocusPopup`, `onBoundsChanged` (saves popup geometry to config), toolbar/command listeners. |
| `js/state.js` | Exports a single `state` object holding all shared mutable UI state. |
| `js/db-api.js` | Exports `db` — the sidebar-side message wrapper (`db.send`, `db.query`, etc.). |
| `js/helpers.js` | Pure helpers: `escHtml`, `nodeIcon`, `nodeLabel`, `fmtDate`, `subtreeMarkdown`, `highlightText`, `childrenOf`, `allDescendantIds`, `recomputeDupUrls`, `setStatus`. |
| `js/focus.js` | `syncFocusState`, `applyFocusHighlights`. |
| `js/render.js` | `buildTree`, `render`, `load`, `loadTags`. |
| `js/events.js` | All DOM event listeners: tree clicks, action buttons, context menu, drag/drop, search, toolbar, live Chrome events, config section expand/collapse. |
| `js/sql-panel.js` | SQL panel: `loadQuickQueries`, `runSQL`, save/delete/restore query buttons, resize handle, schema popup. |
| `js/config.js` | `loadTheme`, `buildColorGrid`, color reset, `loadDateFormat`/date-format input, import/export (TabOutliner + SQL). |
| `js/tags.js` | Tag picker overlay, `loadCfgTags`, config tags panel, `btn-tag-search` handler. |
| `js/actions-cfg.js` | `loadCfgActions`, `showActionEditor`, config actions panel. |

## DB schema

### `node` table — everything is a node

```
id            INTEGER PK AUTOINCREMENT
parent_id     INTEGER → node(id)
node_type     TEXT  -- 'win' | 'tab' | 'group' | 'textnote' | 'split'
position      INTEGER  -- Chrome tab index (mirror of live Chrome state)
is_collapsed  INTEGER (0/1)
is_open       INTEGER (0/1)  -- live in Chrome right now (chrome_id set)
is_saved      INTEGER (0/1)  -- sticky "keep this node" flag, ORTHOGONAL to is_open
is_pinned     INTEGER (0/1)
order_by      INTEGER  -- sibling order in the tree; kept packed 0..n-1 per parent_id
chrome_id     INTEGER  -- Chrome window/tab/tabGroup ID; NULL when is_open=0; unique per (node_type, chrome_id)
title         TEXT
url           TEXT
domain        TEXT  -- hostname extracted from url, auto-populated by upsertNode
favicon_url   TEXT
note_text     TEXT
color_active  TEXT  -- for group nodes: Chrome tab group color name (e.g. 'blue', 'red')
color_saved   TEXT
relicons      TEXT  -- window type: 'normal' | 'popup' | 'devtools'
win_rect      TEXT  -- "left_top_width_height"
created_at    TEXT  -- datetime('now')
updated_at    TEXT  -- datetime('now')
```

`domain` is auto-populated by `extractDomain(url)` whenever `url` is set.

**`updated_at` is trigger-managed** (`node_touch`, created in `applySchema`): it bumps only when a meaningful column changes (`parent_id`, `node_type`, `is_open`, `is_saved`, `is_pinned`, `title`, `url`, `note_text`, `color_*`). Chrome-mirror churn (`position`, `chrome_id`, `favicon_url`, `win_rect`, `is_collapsed`) and `order_by` renumbering don't count. Don't write `updated_at=datetime('now')` in UPDATEs — except user-initiated moves (`move_node`, `chromeReparentTab`), which set it explicitly because a same-parent reorder only changes `order_by`; the trigger skips rows whose statement already changed `updated_at`. Delete rules' `delay_days` and restore-adoption windows therefore measure time since the last real change.

**`is_saved` is orthogonal to `is_open`** — a tab can be open AND saved at once (shown with a green `.saved-dot`). `is_saved` means "keep this node": closing a saved tab/window keeps the row in place (`is_open=0, chrome_id=NULL`, parent/order untouched); closing an unsaved tab deletes the row and splices its children onto its parent. Only tree-side delete removes a saved node. Auto `save_on_close` rules set `is_saved` when a tab is created or its url/title changes — never at close time. Reopening a saved node keeps `is_saved=1`.

There is no root node: windows (and anything dragged to the top) have `parent_id IS NULL`. `applySchema()` migrates away the former `session` root by promoting its children. New root nodes take `order_by = NEXT_ROOT_ORDER`. `order_by` is renumbered (`renumberOrderBy` in bg-db.js, two-phase via temp table; a `null` in its parent-id list means the root level) after any structural mutation.

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

### `config` table
Key/value store for persistent settings. Written by `set_config`, read by `get_config`.
```
key   TEXT PRIMARY KEY
value TEXT
```

Used keys:
- `color_--<css-prop>` — one entry per CSS custom property (e.g. `color_--bg`, `color_--accent`). Written on any color change; read at load to restore the theme.
- `popup_width`, `popup_height`, `popup_left`, `popup_top` — popup window geometry, updated by `chrome.windows.onBoundsChanged`, applied when opening a new popup.
- `date_format` (default `MM-DD h:mm A`) — template for the tree's updated_at column; tokens `YYYY YY MM DD HH H hh h mm ss A a` (`formatDate` in helpers.js); `''` hides the column. `applyDateFormat` in config.js sizes `--date-w` from it.
- `adopt_candidate_hours` (default 24) — how far back from the newest `updated_at` older than one hour a saved closed window must have changed to qualify as a restore-adoption candidate; also the plain now-relative window for single-tab silent re-attach.

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
condition      TEXT  -- search string or SQL SELECT returning node ids
config         TEXT  -- JSON: {tag_id?, delay_days?, window_name?, target_win_id? (legacy)}
is_auto        INTEGER (0/1)
position       INTEGER
created_at     TEXT
```

The engine (`bg-rules.js`) fills TEMP TABLE `tmp_rule_match(id)` from the condition, then each action is a batch statement:
- `save_on_close`: marks matching open tabs `is_saved=1` — no closing. `onTabRemoved` just honors the flag.

Every `is_auto` rule (any action type) also runs per-node via `applyAutoRules(nodeId)` on tab create and url/title change: the match set is narrowed to that one node, so each action's batch SQL touches only it. The loop stops early if an action (delete/move) removed the node. `run_auto_actions` still runs the same rules across the whole tree on demand.
- `delete`: after the `delay_days` age gate, deletes the matched subtrees (recursive CTE, like `delete_node`) and closes any open Chrome tabs/windows they contained. Rows are deleted before the Chrome close so the resulting events no-op.
- `move`: resolves `config.window_name` to a win node by title, creating it as a saved closed root-level window when absent. Matched tabs reparent under it (relative order kept, appended); each moved tab's descendants splice onto its former parent. If a moved tab is open and the target window is closed, the window is reopened around that tab via `chrome.windows.create({tabId})` (its own saved children stay closed) and remaining open tabs are chrome-moved in.
- `add_tag`: single `INSERT OR IGNORE ... SELECT`.

## Node types

| Type | Meaning |
|---|---|
| `win` | Chrome window — `is_open=1` + `chrome_id` while live; `is_open=0` when closed (kept only if saved or holding saved/textnote content) |
| `tab` | Chrome tab — `is_open=1` + `chrome_id` while live; `is_saved=1` marks it sticky regardless of open state |
| `group` | Chrome tab group — `chrome_id` = tabGroup.id, parent = win node, children = tab nodes. Also used as user-defined folders when `chrome_id` is NULL. |
| `textnote` | Freeform text note — counts as keep-worthy content when deciding whether a closing window survives |
| `split` | Visual divider (formerly `separatorline`). Chrome split-view tracking not implemented (no extension API). |

## Module structure

`background.js` is an ES module MV3 service worker (`"type": "module"` in manifest). It imports from `js/bg-*.js` and `js/common.js`. Each `bg-*.js` file exports the functions it provides; event listeners in `bg-sync.js` and `bg-popup.js` register as side effects of import. `handleMessage` (the big switch) and the `onMessage` listener live in `background.js` itself.

Shared mutable service-worker state (`pendingAdopt`, `pendingWinAdopt`, `adoptedTabIds`, `movingTabIds`) lives in `bgState` exported from `js/bg-db.js` and imported by `bg-rules.js`, `bg-sync.js` and `background.js`.

### The two-tree sync contract

Chrome's live tabs/windows/groups and the TabSQL tree are reconciled with an asymmetric rule:
- **TabSQL-initiated moves** (`move_node`, drag in the tree) move the node AND its open descendants in Chrome (`cascadeChildrenToChrome`, DFS via recursive CTE) — referer relationships are preserved.
- **Chrome-initiated moves** (tab-strip drag → `onMoved`, cross-window drag → `onDetached`/`onAttached`, group membership change → `onUpdated.groupId`) reparent ONLY the moved node (`chromeReparentTab`): its children splice onto its former parent, and the node lands under the group/window Chrome reports at the order slot implied by its tab index.
- `movingTabIds` (5s TTL) marks our own programmatic `chrome.tabs.move` calls so their echo events only refresh `position` instead of re-reparenting. `onDetached` must never consume the sentinel — the following `onAttached` needs it.
- Divergence is legal: a tab node may live under a closed window in the tree while its Chrome tab is open elsewhere. Close paths skip nodes whose `chrome_id` is still live in another window.

`tree.js` is an ES module entry point. It imports all sidebar sub-modules (which register their own event listeners as side effects on import) then runs the boot sequence. Shared mutable state lives in `js/state.js` as a single exported `state` object; all modules import and mutate it directly.

### Search term parsing

`js/common.js` holds `parseSearchTerms(q)`, which is used by both sides. `buildSearchWhere` in `bg-db.js` calls `parseSearchTerms` directly and converts the result to parameterized SQL LIKE clauses. `highlightText` in `helpers.js` calls `parseSearchTerms` to highlight bare terms in rendered labels. Add new field prefixes to both `buildSearchWhere` (SQL side) and `highlightText` logic when extending search.

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
    // UPDATE only provided columns; node_touch handles updated_at
    sqlRun(`UPDATE node SET ${cols.map(c => `${c}=?`).join(', ')} WHERE id=?`,
           [...cols.map(c => node[c] ?? null), node.id]);
    return node.id;
  }
  // INSERT
}
```
Safe to call with `{ id, note_text: val }` — won't clobber other fields.

### pendingAdopt — open a saved tab without creating a duplicate node
When tree.js wants to re-open a saved tab, it calls `pre_open_tab` BEFORE `chrome.tabs.create`. `onTabCreated` then checks `pendingAdopt` (5s TTL) and grafts the chrome identity onto the existing node in place — parent, order_by and is_saved untouched.

### pendingWinAdopt — reopen a window node without a duplicate win row
Set before any `chrome.windows.create` that should bind to an EXISTING win node (`open_saved_window`, move-rule reopen). `onWindowCreated` consumes it (5s TTL, single-shot) instead of inserting a fresh win node — closes the race between the create() promise and the event.

### adoptedTabIds — bulk tab reopen
Handlers that open tabs for existing nodes (`open_saved_window`, `open_search_in_window`) add the new Chrome tab IDs to `adoptedTabIds`; `onTabCreated` skips any ID in this set.

### Restore adoption (restart / session-restore recovery)
Chrome reuses small integer ids across restarts, so `initialize()` detects a new browser session via a `chrome.storage.session` marker (cleared on restart) and NULLs every stored `chrome_id` first. `resync()` then inserts the restored windows as fresh nodes and `adoptWindows()` merges them back: fresh windows (node created < 3 min ago) are scored against candidates (stale-open, or closed-saved with `updated_at` ≥ `MAX(updated_at older than 1h) - adopt_candidate_hours` — anchored at last pre-restore activity so the restore's own churn is ignored and long browser downtime doesn't age candidates out) by URL-multiset overlap of their tabs; a merge needs ≥ half the fresh tabs matched (err toward duplication) and pairing is greedy best-score, unique both sides. `mergeWindow(from, into, fromLive)` grafts chrome ids onto the old nodes — tabs pair by (url, rank), groups by (title, rank) — so tree placement survives; paired from-nodes carry tags/is_saved/notes over; unpaired children reparent under the adopted window. Both it and `dedupeWindows` need `tmp_live` (`fillLiveTable`).

### Duplicate-window merge (manual refresh only)
The ↺ button sends `resync { dedupe: true }`; after resync, `dedupeWindows` repeatedly merges the weakest redundant window: one whose every distinct tab URL exists in a single other window. When two windows cover each other the deeper nesting (max descendant level below the win) survives, then more tabs, then older id. Two live windows are never merged. A live redundant window grafts its Chrome identity onto the kept closed one; a closed one just folds in. The same adoption runs debounced (`scheduleAdoption`, 1.5s) after tab/window creation bursts for post-boot restores, and `onTabCreated` silently re-attaches a single restored tab to a recently saved same-URL node under the same window (Ctrl+Shift+T).

### resync stale cleanup
Open nodes no longer present in Chrome: saved tabs close in place; unsaved stale tabs and stale groups are deleted with survivors spliced up to the nearest kept ancestor (`spliceOutDoomed`, one-hop loop); stale windows survive (promoted to `is_saved=1`) only when holding saved or textnote content. `resync` never touches `parent_id`, `order_by`, or `is_saved` of matched nodes.

### auto action rules
All `is_auto=1` rules are evaluated against the affected node when a tab is CREATED or its url/title changes (`applyAutoRules`) — `save_on_close` sets `is_saved=1` while the tab is still open, `add_tag`/`move`/`delete` act immediately. `onTabRemoved` does no rule matching — it just keeps saved nodes and deletes unsaved ones.

## Message protocol (background.js ↔ tree.js)

All messages: `{ to: 'background', cmd, payload }` → response `{ ok, data }` or `{ ok: false, error }`.

| cmd | payload | returns |
|---|---|---|
| `bulk_exec` | `{ sql }` | `{ rows }` |
| `upsert_node` | `{ node }` | `{ id }` — inserts without `parent_id` land at the root level |
| `delete_node` | `{ id }` | cascade-deletes all descendants + node_tag/win_auto_tag cleanup (recursive CTE, one exec) |
| `move_node` | `{ id, parent_id, order_by }` | TabSQL-side move: chrome-moves the tab and cascades open descendants |
| `search` | `{ q }` | `{ matchedCount, visibleIds }` — supports field-prefix syntax |
| `pre_open_tab` | `{ nodeId, url }` | sets pendingAdopt |
| `open_saved_window` | `{ winNodeId }` | reopens all saved descendant tabs (DFS order) into a new window; nodes keep is_saved=1 |
| `save_window` | `{ winNodeId }` | marks win + all descendant tabs saved, then closes the Chrome window |
| `move_to_new_window` | `{ id }` | `{ moved }` — reparents the subtree under a new root win node; open tabs (DFS order) chrome-move into a new window via `chromeMoveIntoWin`; live groups in the subtree become folders (chrome_id NULL) |
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
| `resync` | `{ dedupe? }` | `{ merged? }` — reconcile with Chrome; `dedupe` also runs `dedupeWindows` |
| `get_schema` | — | `{ schema }` — object keyed by table/view name, values are PRAGMA table_info rows |
| `get_config` | `{ key? }` | `{ value }` if key given; `{ values: {key→val} }` for all entries |
| `set_config` | `{ key, value }` or `{ entries: {key→val} }` | — |

## Search term parser

`parseSearchTerms(q)` in `js/common.js` splits a query into `[{field, value}]`. Field is null for bare terms. `buildSearchWhere(q)` in `bg-db.js` calls it and returns `{ where, params }` for a parameterized SQL WHERE clause. Supported field prefixes: `title`, `url`, `domain`, `note`, `label`, `tag`, `id` (`id:1,2,3` — exact id list; the SQL panel's ⧩ Filter button writes one from the last result's `id`/`node_id` column).

### updateBadge
Called after every tab/window create/remove event and on boot. Queries the open tab count and sets `chrome.action.setBadgeText`.

### Popup geometry persistence
`chrome.windows.onBoundsChanged` fires whenever the popup is moved or resized. If the changed window matches `popupWinId` in session storage, the new `width/height/left/top` values are written to the `config` table. `openOrFocusPopup` reads those four keys before calling `chrome.windows.create`.

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

### Saved indicator
Saved tabs/windows show a green circle (`.saved-dot`, colored `--saved-tab`) before the icon, whether open or closed. Icons key off `is_open` (`⬤`/`·`, `🪟`/`📁`). The context menu has "Toggle saved"; the 💾 button marks saved then closes (the sticky flag keeps the node).

### Row layout
Each `.node` row starts with a fixed-width `.upd` column (`--date-w`, local `updated_at` in `state.dateFormat`, full timestamp in its tooltip), then a `.indent` spacer of `depth * 16px`, then toggle/indicators/icon. Depth is also in `data-depth`.

### Drag-to-dedent
`nodeLevel = data-depth`; `hoverLevel = floor((mouseX - indentSpacer.left) / 16)`. If `hoverLevel < nodeLevel`, walk up ancestors `(nodeLevel - hoverLevel)` steps to find effective parent (null = root level).

### Drag out as markdown
`dragstart` sets `text/plain` to `subtreeMarkdown(id)` — a nested `- [title](url) — note` list of the node and its descendants (only those in `state.searchVisible` while a search is active) — so dropping into an external editor pastes it. In-tree drops ignore dataTransfer and use `state.dragSrcId`.

### Note rows
Every node emits a sibling `.note-row[data-note-for=id]` div. Hidden via `.empty` class when `note_text` is null. Edit button (`✎`) replaces it with an inline input; saves via `upsertNode({ id, note_text })`.

### Inline edit saves without full re-render
The `act-edit` handler surgically updates the note row DOM and `nodeMap[id].note_text` in place. `load()` is not called — avoids collapsing the tree.

### scheduleRefresh
Debounced `load()` call (600ms) triggered by Chrome tab/window events and after mutations.

## CSS conventions (index.html)

- CSS custom properties in `:root`: `--bg`, `--surface`, `--border`, `--accent`, `--text`, `--muted`, `--hover`, `--win-icon`, `--tab-icon`, `--focus-bg`, `--dup-url`, `--saved-tab`, `--indent` (16px), `--row-h` (28px)
- `.action-editor` is a two-column grid (`max-content 1fr`); `.action-editor-row` uses `display: contents` so rows can still be hidden with inline `display: none`
- `.node` rows indent via an inline-width `.indent` spacer after the `.upd` date column — not nested divs
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
- **Prefer SQL over JS logic** — when an operation can be expressed as a SQL query (SELECT, UPDATE, DELETE with subqueries, CTEs, recursive CTEs), do it in SQL rather than looping in JS. Use `node_tree` view for recursive ancestor/descendant queries instead of JS recursion.

## Views

| View | Purpose |
|---|---|
| `tab_flat` | All tab nodes joined with their direct parent |
| `window_summary` | Win nodes with open/total tab counts |
| `node_tree` | All nodes with `level` (depth, 1=root level, i.e. windows), `win_node_id` (ancestor win id), `group_node_id` (ancestor group id) — use for recursive descendant queries instead of JS recursion |

## Known constraints

- Bash sandbox is broken in this environment (bwrap fails: `Can't mount tmpfs on .../.aws`) — use Read/Edit/Write tools directly; ask the user to run shell commands
- sql.js WASM requires `'wasm-unsafe-eval'` in the extension's CSP (already in manifest.json)
- The code assumes the bundled SQLite supports window functions (≥3.25) and `RETURNING` (≥3.35)
- SQLite gotcha: correlated subqueries in an UPDATE see rows the same statement already modified — snapshot ranks into a temp table first (see `renumberOrderBy`)
- sql.js `bind` takes EITHER a positional array or an all-named object (`:name`) — never mix `?` with named params in one statement
- Service workers are terminated by Chrome when idle and restart on next event — `initialize()` must be idempotent; a `chrome.storage.session` marker distinguishes SW restarts (chrome_ids valid) from browser restarts (all chrome_ids invalid, nulled before resync)
- `chrome.storage.local` holds the serialized DB as a plain array; exported via `db.export()` on every write
