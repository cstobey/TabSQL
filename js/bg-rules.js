import {
  sqlQuery, sqlRun, sqlExec, sqlInsert, persistDb, rowsModified,
  buildSearchWhere, renumberOrderBy, bgState, NEXT_ROOT_ORDER,
} from './bg-db.js';

// Fills TEMP TABLE tmp_rule_match(id) with node ids matching the rule condition.
// SQL conditions must yield an `id` column; a failing condition matches nothing.
const bareSql = s => String(s ?? '').replace(/;+\s*$/, '');

function matchRule(rule) {
  sqlExec(`DROP TABLE IF EXISTS tmp_rule_match; CREATE TEMP TABLE tmp_rule_match (id INTEGER PRIMARY KEY);`);
  try {
    if (rule.condition_type === 'search') {
      const { where, params } = buildSearchWhere(rule.condition);
      sqlRun(`INSERT OR IGNORE INTO tmp_rule_match SELECT id FROM node WHERE ${where}`, params);
    } else {
      sqlRun(`INSERT OR IGNORE INTO tmp_rule_match SELECT id FROM (${bareSql(rule.condition)})`);
    }
  } catch { return false; }
  return true;
}

// Finds the target window by title (config.window_name), creating it as a saved,
// closed root-level window when absent. Numeric target_win_id is the legacy fallback
// for rules saved before named targets existed.
function resolveTargetWin(cfg) {
  if (!cfg.window_name) return cfg.target_win_id ?? null;
  const row = sqlQuery(
    `SELECT id FROM node WHERE node_type='win' AND title=? ORDER BY is_open DESC, updated_at DESC LIMIT 1`,
    [cfg.window_name]
  )[0];
  if (row) return row.id;
  return sqlInsert(
    `INSERT INTO node (node_type, title, is_open, is_saved, parent_id, order_by)
     VALUES ('win', ?, 0, 1, NULL, ${NEXT_ROOT_ORDER})`,
    [cfg.window_name]
  );
}

// Chrome-moves open tabs (chrome ids, in order) into the win node's window. A closed
// win node is reopened around the first tab via windows.create({tabId}) — its own
// saved children stay closed — and pendingWinAdopt keeps onWindowCreated from
// inserting a duplicate win row.
export async function chromeMoveIntoWin(winId, tabChromeIds) {
  if (!tabChromeIds.length) return;
  let winChromeId = sqlQuery(`SELECT chrome_id FROM node WHERE id=? AND is_open=1`, [winId])[0]?.chrome_id;
  let rest = tabChromeIds;
  if (!winChromeId) {
    const [first, ...others] = tabChromeIds;
    rest = others;
    bgState.movingTabIds.set(first, Date.now());
    bgState.pendingWinAdopt = { nodeId: winId, ts: Date.now() };
    const win = await chrome.windows.create({ tabId: first });
    winChromeId = win.id;
    sqlRun(
      `UPDATE node SET is_open=1, chrome_id=?, relicons=?, win_rect=? WHERE id=?`,
      [win.id, win.type ?? 'normal', `${win.left}_${win.top}_${win.width}_${win.height}`, winId]
    );
  }
  for (const cid of rest) {
    bgState.movingTabIds.set(cid, Date.now());
    try { await chrome.tabs.move(cid, { windowId: winChromeId, index: -1 }); } catch {}
  }
}

const ACTIONS = {
  add_tag(cfg) {
    if (!cfg.tag_id) return 0;
    sqlRun(`INSERT OR IGNORE INTO node_tag (node_id, tag_id) SELECT id, ? FROM tmp_rule_match`, [cfg.tag_id]);
    return rowsModified();
  },

  // Deletes matched subtrees (like delete_node) after the optional age gate, closing
  // any open Chrome tabs/windows they contain. DB rows are removed first so the
  // resulting Chrome close events find nothing and no-op.
  async delete(cfg) {
    const days = +(cfg.delay_days ?? 0);
    if (days > 0) {
      sqlRun(
        `DELETE FROM tmp_rule_match WHERE id NOT IN (SELECT id FROM node WHERE updated_at <= datetime('now', ?))`,
        [`-${days} days`]
      );
    }
    const count = sqlQuery(`SELECT COUNT(*) c FROM tmp_rule_match`)[0].c;
    if (!count) return 0;
    sqlExec(`
      DROP TABLE IF EXISTS tmp_doomed;
      CREATE TEMP TABLE tmp_doomed AS
        WITH RECURSIVE d(id) AS (
          SELECT id FROM tmp_rule_match
          UNION
          SELECT n.id FROM node n JOIN d ON n.parent_id = d.id
        ) SELECT id FROM d;
    `);
    sqlExec(`
      DELETE FROM node_tag     WHERE node_id     IN (SELECT id FROM tmp_doomed);
      DELETE FROM win_auto_tag WHERE win_node_id IN (SELECT id FROM tmp_doomed);
    `);
    const closers = sqlQuery(`
      DELETE FROM node WHERE id IN (SELECT id FROM tmp_doomed)
      RETURNING node_type, chrome_id, is_open`
    ).filter(r => r.is_open && r.chrome_id);
    sqlExec(`DROP TABLE tmp_doomed`);
    for (const w of closers.filter(r => r.node_type === 'win')) {
      try { await chrome.windows.remove(w.chrome_id); } catch {}
    }
    const tabIds = closers.filter(r => r.node_type === 'tab').map(r => r.chrome_id);
    if (tabIds.length) { try { await chrome.tabs.remove(tabIds); } catch {} }
    return count;
  },

  // Moves matched tabs under the named window. Descendants of a moved tab are
  // spliced onto its former parent (looping one hop at a time handles chains of
  // matched ancestors). Moved tabs keep their relative order, appended after the
  // target's existing children. If any moved tab is open and the target window is
  // closed, the window is reopened around the first such tab — without opening the
  // window's own saved children — and the rest are chrome-moved into it.
  async move(cfg) {
    const winId = resolveTargetWin(cfg);
    if (winId == null) return 0;
    sqlRun(
      `DELETE FROM tmp_rule_match WHERE id NOT IN
         (SELECT id FROM node WHERE node_type='tab' AND parent_id IS NOT ? AND id != ?)`,
      [winId, winId]
    );
    const moved = sqlQuery(`
      SELECT n.id, n.parent_id, n.chrome_id, n.is_open
      FROM node n JOIN tmp_rule_match m ON m.id = n.id ORDER BY n.order_by, n.id`);
    if (!moved.length) return 0;

    do {
      sqlRun(`
        UPDATE node SET parent_id = (SELECT p.parent_id FROM node p WHERE p.id = node.parent_id)
        WHERE parent_id IN (SELECT id FROM tmp_rule_match)
          AND id NOT IN (SELECT id FROM tmp_rule_match)`);
    } while (rowsModified());

    const base = sqlQuery(
      `SELECT COALESCE(MAX(order_by),-1)+1 b FROM node
       WHERE parent_id=? AND id NOT IN (SELECT id FROM tmp_rule_match)`, [winId]
    )[0].b;
    sqlExec(`
      DROP TABLE IF EXISTS tmp_rank;
      CREATE TEMP TABLE tmp_rank AS
        SELECT n.id, ROW_NUMBER() OVER (ORDER BY n.order_by, n.id) - 1 rk
        FROM node n JOIN tmp_rule_match m ON m.id = n.id;
      UPDATE node SET parent_id = ${Math.trunc(+winId)},
        order_by = ${Math.trunc(+base)} + (SELECT rk FROM tmp_rank r WHERE r.id = node.id)
      WHERE id IN (SELECT id FROM tmp_rank);
      DROP TABLE tmp_rank;
    `);
    renumberOrderBy([...new Set([winId, ...moved.map(t => t.parent_id)])]);
    await chromeMoveIntoWin(winId, moved.filter(t => t.is_open && t.chrome_id).map(t => t.chrome_id));
    return moved.length;
  },

  save_on_close() {
    sqlRun(`
      UPDATE node SET is_saved=1
      WHERE id IN (SELECT id FROM tmp_rule_match) AND node_type='tab' AND is_saved=0`);
    return rowsModified();
  },
};

export async function executeActionRule(rule) {
  if (!matchRule(rule)) return 0;
  const cfg = rule.config ? JSON.parse(rule.config) : {};
  const count = ACTIONS[rule.action_type] ? await ACTIONS[rule.action_type](cfg) : 0;
  sqlExec(`DROP TABLE IF EXISTS tmp_rule_match`);
  await persistDb();
  return count;
}

// Runs every is_auto rule against ONE node — called on tab create and on url/title
// refresh, so auto rules fire as tabs appear/change instead of only via "run all".
// The match set is narrowed to nodeId so each action's batch SQL touches nothing else;
// save_on_close therefore marks the tab while it is still open. Stops early if an
// action (delete/move) removed the node.
export async function applyAutoRules(nodeId) {
  let count = 0;
  for (const rule of sqlQuery(`SELECT * FROM action_rule WHERE is_auto=1 ORDER BY position, id`)) {
    if (!matchRule(rule)) continue;
    sqlRun(`DELETE FROM tmp_rule_match WHERE id IS NOT ?`, [nodeId]);
    if (!sqlQuery(`SELECT COUNT(*) c FROM tmp_rule_match`)[0].c) continue;
    try {
      const cfg = rule.config ? JSON.parse(rule.config) : {};
      count += ACTIONS[rule.action_type] ? await ACTIONS[rule.action_type](cfg) : 0;
    } catch {}
    if (!sqlQuery(`SELECT 1 FROM node WHERE id=?`, [nodeId]).length) break;
  }
  sqlExec(`DROP TABLE IF EXISTS tmp_rule_match`);
  return count;
}
