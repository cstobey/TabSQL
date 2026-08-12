import {
  ensureDb, persistDb, sqlQuery, sqlRun, sqlInsert, sqlExec,
  extractDomain, bgState, getRecursiveOpenChildren, getWinChromeId,
  sessionId, renumberOrderBy, rowsModified, cfgNum,
} from './bg-db.js';
import { applyAutoRules } from './bg-rules.js';

function nodeDbId(chromeId, type) {
  return sqlQuery(
    `SELECT id FROM node WHERE chrome_id=? AND node_type=? LIMIT 1`,
    [chromeId, type]
  )[0]?.id ?? null;
}

// ── Shared SQL helpers ────────────────────────────────────────────────────────

// Requires TEMP TABLE tmp_doomed(id). Hops children of doomed nodes to their
// grandparent one level per pass (chains of doomed ancestors converge), then drops
// the doomed rows and their tag references.
function spliceOutDoomed() {
  do {
    sqlRun(`
      UPDATE node SET parent_id = (SELECT p.parent_id FROM node p WHERE p.id = node.parent_id)
      WHERE parent_id IN (SELECT id FROM tmp_doomed) AND id NOT IN (SELECT id FROM tmp_doomed)`);
  } while (rowsModified());
  sqlExec(`
    DELETE FROM node_tag     WHERE node_id     IN (SELECT id FROM tmp_doomed);
    DELETE FROM win_auto_tag WHERE win_node_id IN (SELECT id FROM tmp_doomed);
    DELETE FROM node         WHERE id          IN (SELECT id FROM tmp_doomed);
    DROP TABLE tmp_doomed;
  `);
}

async function syncWindowPositions(winChromeId) {
  const tabs = await chrome.tabs.query({ windowId: winChromeId }).catch(() => []);
  if (!tabs.length) return;
  sqlExec(`DROP TABLE IF EXISTS tmp_pos; CREATE TEMP TABLE tmp_pos (chrome_id INTEGER PRIMARY KEY, idx INTEGER);`);
  sqlRun(`INSERT INTO tmp_pos VALUES ${tabs.map(() => '(?,?)').join(',')}`, tabs.flatMap(t => [t.id, t.index]));
  sqlExec(`
    UPDATE node SET position = (SELECT idx FROM tmp_pos WHERE tmp_pos.chrome_id = node.chrome_id)
    WHERE node_type='tab' AND is_open=1 AND chrome_id IN (SELECT chrome_id FROM tmp_pos);
    DROP TABLE tmp_pos;
  `);
}

// ── Cascade helper (TabSQL-initiated moves follow the tree: descendants come along) ──

export async function cascadeChildrenToChrome(nodeId, startIndex, windowId) {
  const children = getRecursiveOpenChildren(nodeId);
  let idx = startIndex;
  for (const child of children) {
    bgState.movingTabIds.set(child.chrome_id, Date.now());
    try { await chrome.tabs.move(child.chrome_id, { windowId, index: idx }); } catch {}
    idx++;
  }
}

// Chrome-initiated relocation of one tab (drag in the tab strip, cross-window drag,
// group membership change). Per the sync contract the node's children do NOT follow:
// they splice onto its former parent. The node itself reparents to the group/window
// Chrome now reports and lands at the order slot implied by its new tab index — the
// fractional order_by drops it between its Chrome-order neighbors and the renumber
// pass makes it integral again.
async function chromeReparentTab(tabChromeId) {
  const node = sqlQuery(
    `SELECT id, parent_id FROM node WHERE node_type='tab' AND chrome_id=? LIMIT 1`,
    [tabChromeId]
  )[0];
  if (!node) return;
  let tab;
  try { tab = await chrome.tabs.get(tabChromeId); } catch { return; }
  const newPid = (tab.groupId !== -1 ? nodeDbId(tab.groupId, 'group') : null) ?? nodeDbId(tab.windowId, 'win');
  if (newPid == null) return;
  await syncWindowPositions(tab.windowId);
  sqlRun(`UPDATE node SET parent_id=? WHERE parent_id=?`, [node.parent_id, node.id]);
  sqlRun(`
    UPDATE node SET parent_id=:pid, updated_at=datetime('now'),
      order_by = COALESCE((SELECT s.order_by FROM node s
        WHERE s.parent_id=:pid AND s.id!=:id AND s.node_type='tab' AND s.is_open=1 AND s.position < :idx
        ORDER BY s.position DESC LIMIT 1), -1) + 0.5
    WHERE id=:id`,
    { ':pid': newPid, ':id': node.id, ':idx': tab.index }
  );
  renumberOrderBy([node.parent_id, newPid].filter(p => p != null));
}

// ── resync ────────────────────────────────────────────────────────────────────

// Reconciles the DB with live Chrome state:
//   1. snapshot Chrome into tmp_node and match rows by (chrome_id, node_type)
//   2. update matched nodes in place — parent_id, order_by and is_saved are never
//      touched, so tree placement and the sticky saved flag survive
//   3. insert unmatched Chrome objects as new nodes (windows under the session root)
//   4. adoptWindows() merges just-inserted duplicate windows into nodes that were
//      open recently (restart / session-restore recovery), then tmp ids re-match
//   5. open nodes no longer present in Chrome: saved ones (and windows holding
//      anything saved or a textnote) close in place; the rest are deleted with
//      survivors spliced up to the nearest kept ancestor
export async function resync() {
  await ensureDb();
  const [wins, groups] = await Promise.all([
    chrome.windows.getAll({ populate: true }),
    chrome.tabGroups.query({}),
  ]);

  sqlExec(`
    DROP TABLE IF EXISTS tmp_node;
    CREATE TEMP TABLE tmp_node (
      id               INTEGER,
      chrome_id        INTEGER NOT NULL,
      node_type        TEXT    NOT NULL,
      parent_chrome_id INTEGER,
      parent_node_type TEXT,
      position         INTEGER NOT NULL DEFAULT 0,
      is_pinned        INTEGER NOT NULL DEFAULT 0,
      is_collapsed     INTEGER NOT NULL DEFAULT 0,
      title            TEXT,
      url              TEXT,
      domain           TEXT,
      favicon_url      TEXT,
      color_active     TEXT,
      relicons         TEXT,
      win_rect         TEXT
    );
  `);

  const winRows = wins.map(w => [w.id, w.type ?? 'normal', `${w.left}_${w.top}_${w.width}_${w.height}`]);
  if (winRows.length) sqlRun(
    `INSERT INTO tmp_node (chrome_id, node_type, relicons, win_rect)
     VALUES ${winRows.map(() => `(?,'win',?,?)`).join(',')}`,
    winRows.flat()
  );
  const groupRows = groups.map(g => [g.id, g.windowId, g.title ?? '', g.color ?? null, g.collapsed ? 1 : 0]);
  if (groupRows.length) sqlRun(
    `INSERT INTO tmp_node (chrome_id, node_type, parent_chrome_id, parent_node_type, title, color_active, is_collapsed)
     VALUES ${groupRows.map(() => `(?,'group',?,'win',?,?,?)`).join(',')}`,
    groupRows.flat()
  );
  const tabRows = wins.flatMap(w => (w.tabs ?? []).map(t => {
    const url = t.pendingUrl || t.url || '';
    return [t.id,
            t.groupId !== -1 ? t.groupId : w.id, t.groupId !== -1 ? 'group' : 'win',
            t.index ?? 0, t.pinned ? 1 : 0,
            t.title ?? '', url, extractDomain(url), t.favIconUrl ?? ''];
  }));
  if (tabRows.length) sqlRun(
    `INSERT INTO tmp_node (chrome_id, node_type, parent_chrome_id, parent_node_type, position, is_pinned, title, url, domain, favicon_url)
     VALUES ${tabRows.map(() => `(?,'tab',?,?,?,?,?,?,?,?)`).join(',')}`,
    tabRows.flat()
  );

  const rematch = `
    UPDATE tmp_node SET id = (
      SELECT n.id FROM node n WHERE n.chrome_id = tmp_node.chrome_id AND n.node_type = tmp_node.node_type
    )`;

  sqlExec(`
    ${rematch};

    UPDATE node SET
      position     = (SELECT t.position     FROM tmp_node t WHERE t.id = node.id),
      is_open      = 1,
      is_pinned    = (SELECT t.is_pinned    FROM tmp_node t WHERE t.id = node.id),
      is_collapsed = (SELECT t.is_collapsed FROM tmp_node t WHERE t.id = node.id),
      title        = COALESCE((SELECT t.title        FROM tmp_node t WHERE t.id = node.id), node.title),
      url          = COALESCE((SELECT t.url          FROM tmp_node t WHERE t.id = node.id), node.url),
      domain       = COALESCE((SELECT t.domain       FROM tmp_node t WHERE t.id = node.id), node.domain),
      favicon_url  = COALESCE((SELECT t.favicon_url  FROM tmp_node t WHERE t.id = node.id), node.favicon_url),
      color_active = COALESCE((SELECT t.color_active FROM tmp_node t WHERE t.id = node.id), node.color_active),
      relicons     = COALESCE((SELECT t.relicons     FROM tmp_node t WHERE t.id = node.id), node.relicons),
      win_rect     = COALESCE((SELECT t.win_rect     FROM tmp_node t WHERE t.id = node.id), node.win_rect),
      updated_at   = datetime('now')
    WHERE id IN (SELECT id FROM tmp_node WHERE id IS NOT NULL);

    INSERT INTO node (chrome_id, node_type, is_open, is_saved, relicons, win_rect, parent_id, order_by, updated_at)
    SELECT t.chrome_id, 'win', 1, 0, t.relicons, t.win_rect,
           (SELECT id FROM node WHERE node_type='session'),
           (SELECT COALESCE(MAX(n2.order_by),-1)+1 FROM node n2
             WHERE n2.parent_id = (SELECT id FROM node WHERE node_type='session')) + ROW_NUMBER() OVER (ORDER BY t.chrome_id) - 1,
           datetime('now')
    FROM tmp_node t WHERE t.id IS NULL AND t.node_type = 'win';
    ${rematch} WHERE id IS NULL;

    INSERT INTO node (chrome_id, node_type, is_open, is_saved, title, color_active, is_collapsed, parent_id, order_by, updated_at)
    SELECT t.chrome_id, 'group', 1, 0, t.title, t.color_active, t.is_collapsed,
           (SELECT n.id FROM node n WHERE n.chrome_id = t.parent_chrome_id AND n.node_type = 'win'),
           COALESCE((SELECT MAX(n2.order_by)+1 FROM node n2
             WHERE n2.parent_id = (SELECT n.id FROM node n WHERE n.chrome_id = t.parent_chrome_id AND n.node_type = 'win')), 0),
           datetime('now')
    FROM tmp_node t WHERE t.id IS NULL AND t.node_type = 'group';
    ${rematch} WHERE id IS NULL;

    INSERT INTO node
      (chrome_id, node_type, is_open, is_saved, position, is_pinned, title, url, domain, favicon_url, parent_id, order_by, updated_at)
    SELECT t.chrome_id, 'tab', 1, 0, t.position, t.is_pinned,
           t.title, t.url, t.domain, t.favicon_url,
           (SELECT n.id FROM node n WHERE n.chrome_id = t.parent_chrome_id AND n.node_type = t.parent_node_type),
           t.position,
           datetime('now')
    FROM tmp_node t WHERE t.id IS NULL AND t.node_type = 'tab';
    ${rematch} WHERE id IS NULL;
  `);

  await adoptWindows();
  sqlExec(`${rematch}`);

  sqlExec(`
    DROP TABLE IF EXISTS tmp_stale;
    CREATE TEMP TABLE tmp_stale AS
      SELECT n.id, n.node_type, n.is_saved FROM node n
      WHERE n.is_open=1 AND n.node_type IN ('tab','group','win')
        AND n.id NOT IN (SELECT id FROM tmp_node WHERE id IS NOT NULL);

    DROP TABLE IF EXISTS tmp_doomed;
    CREATE TEMP TABLE tmp_doomed AS
      SELECT id FROM tmp_stale WHERE node_type='tab' AND is_saved=0
      UNION
      SELECT id FROM tmp_stale WHERE node_type='group'
      UNION
      SELECT s.id FROM tmp_stale s
      WHERE s.node_type='win' AND s.is_saved=0
        AND NOT EXISTS (SELECT 1 FROM node_tree t WHERE t.win_node_id = s.id
                        AND (t.is_saved=1 OR t.node_type='textnote'));
  `);
  spliceOutDoomed();
  sqlExec(`
    UPDATE node SET is_open=0, chrome_id=NULL, updated_at=datetime('now')
      WHERE is_open=1 AND id IN (SELECT id FROM tmp_stale);
    UPDATE node SET is_saved=1
      WHERE is_saved=0 AND id IN (SELECT id FROM tmp_stale WHERE node_type='win');
    DROP TABLE tmp_stale;
    DROP TABLE tmp_node;
  `);

  renumberOrderBy();
  await persistDb();
}

export async function initialize() {
  await ensureDb();
  // chrome.storage.session dies with the browser session, so a missing marker means
  // every stored chrome_id belongs to a previous session (Chrome reuses small integer
  // ids after restart — stale ids would falsely match). Null them and let adoption
  // re-attach restored windows by URL instead.
  const { sessionAlive } = await chrome.storage.session.get('sessionAlive');
  if (!sessionAlive) {
    sqlRun(`UPDATE node SET chrome_id=NULL WHERE chrome_id IS NOT NULL`);
    await chrome.storage.session.set({ sessionAlive: 1 });
  }
  await resync();
  await updateBadge();
  console.log('TabSQL initialized');
}

// ── Restore adoption ──────────────────────────────────────────────────────────

let adoptTimer = null;
export function scheduleAdoption() {
  clearTimeout(adoptTimer);
  adoptTimer = setTimeout(async () => {
    try {
      await ensureDb();
      if (await adoptWindows()) { renumberOrderBy(); await persistDb(); }
    } catch (e) { console.error('adoptWindows:', e); }
  }, 1500);
}

// Matches freshly-created live windows (node created < 3 min ago) against windows
// that were open recently — stale-open leftovers from before a restart, or windows
// closed+saved within adopt_candidate_hours (config, default 48h). Score is the
// URL-multiset overlap between the fresh window's open tabs and the candidate's
// non-live tabs; a merge needs at least half the fresh tabs matched (low confidence
// errs toward duplication). Greedy best-score pairing, unique on both sides.
export async function adoptWindows() {
  const hours = cfgNum('adopt_candidate_hours', 48);
  const [liveWins, liveTabs, liveGroups] = await Promise.all([
    chrome.windows.getAll({}), chrome.tabs.query({}), chrome.tabGroups.query({}),
  ]);
  sqlExec(`DROP TABLE IF EXISTS tmp_live; CREATE TEMP TABLE tmp_live (chrome_id INTEGER NOT NULL, kind TEXT NOT NULL);`);
  const liveRows = [
    ...liveWins.map(w => [w.id, 'win']),
    ...liveTabs.map(t => [t.id, 'tab']),
    ...liveGroups.map(g => [g.id, 'grp']),
  ];
  if (liveRows.length) sqlRun(`INSERT INTO tmp_live VALUES ${liveRows.map(() => '(?,?)').join(',')}`, liveRows.flat());

  const pairs = sqlQuery(`
    WITH fresh_tab AS (
      SELECT t.win_node_id wid, t.url, COUNT(*) cnt
      FROM node_tree t JOIN node w ON w.id = t.win_node_id
      WHERE t.node_type='tab' AND t.is_open=1 AND t.url != ''
        AND w.is_open=1 AND w.created_at >= datetime('now','-3 minutes')
        AND w.chrome_id IN (SELECT chrome_id FROM tmp_live WHERE kind='win')
      GROUP BY 1, 2
    ),
    cand_tab AS (
      SELECT t.win_node_id wid, t.url, COUNT(*) cnt
      FROM node_tree t JOIN node w ON w.id = t.win_node_id
      WHERE t.node_type='tab' AND t.url != ''
        AND (t.is_open=0 OR t.chrome_id IS NULL OR t.chrome_id NOT IN (SELECT chrome_id FROM tmp_live WHERE kind='tab'))
        AND w.created_at < datetime('now','-3 minutes')
        AND ((w.is_open=1 AND (w.chrome_id IS NULL OR w.chrome_id NOT IN (SELECT chrome_id FROM tmp_live WHERE kind='win')))
          OR (w.is_open=0 AND w.is_saved=1 AND w.updated_at >= datetime('now', :cut)))
      GROUP BY 1, 2
    ),
    fresh_size AS (SELECT wid, SUM(cnt) total FROM fresh_tab GROUP BY wid)
    SELECT f.wid AS fresh_id, c.wid AS cand_id, SUM(MIN(f.cnt, c.cnt)) AS matches, fs.total AS total
    FROM fresh_tab f JOIN cand_tab c ON c.url = f.url JOIN fresh_size fs ON fs.wid = f.wid
    GROUP BY 1, 2
    HAVING SUM(MIN(f.cnt, c.cnt)) * 2 >= fs.total
    ORDER BY matches DESC, fresh_id, cand_id
  `, { ':cut': `-${hours} hours` });

  const usedF = new Set(), usedC = new Set();
  let merged = 0;
  for (const p of pairs) {
    if (usedF.has(p.fresh_id) || usedC.has(p.cand_id)) continue;
    usedF.add(p.fresh_id); usedC.add(p.cand_id);
    mergeWindow(p.fresh_id, p.cand_id);
    merged++;
  }
  sqlExec(`DROP TABLE IF EXISTS tmp_live`);
  return merged;
}

// Grafts the fresh window's Chrome identity onto the candidate node so tree placement
// survives: fresh tabs pair to candidate tabs by (url, rank) and fresh groups to
// candidate groups by (title, rank); paired fresh nodes die and their chrome ids move
// onto the old nodes; unpaired fresh children reparent under the candidate; finally
// the fresh win node disappears and the candidate reopens under its chrome_id.
function mergeWindow(freshId, candId) {
  const f = Math.trunc(+freshId), c = Math.trunc(+candId);
  sqlExec(`
    DROP TABLE IF EXISTS tmp_pairs;
    CREATE TEMP TABLE tmp_pairs AS
    SELECT fr.id fresh_id, ca.id cand_id, fr.chrome_id, fr.position, fr.is_pinned, fr.title, fr.favicon_url
    FROM (SELECT id, url, chrome_id, position, is_pinned, title, favicon_url,
                 ROW_NUMBER() OVER (PARTITION BY url ORDER BY position, id) rn
          FROM node_tree WHERE win_node_id=${f} AND node_type='tab' AND is_open=1 AND url != '') fr
    JOIN (SELECT id, url, ROW_NUMBER() OVER (PARTITION BY url ORDER BY order_by, id) rn
          FROM node_tree WHERE win_node_id=${c} AND node_type='tab' AND url != ''
            AND (is_open=0 OR chrome_id IS NULL OR chrome_id NOT IN (SELECT chrome_id FROM tmp_live WHERE kind='tab'))
         ) ca ON ca.url = fr.url AND ca.rn = fr.rn;

    DROP TABLE IF EXISTS tmp_gpairs;
    CREATE TEMP TABLE tmp_gpairs AS
    SELECT fr.id fresh_id, ca.id cand_id, fr.chrome_id, fr.color_active, fr.is_collapsed
    FROM (SELECT id, title, chrome_id, color_active, is_collapsed,
                 ROW_NUMBER() OVER (PARTITION BY title ORDER BY order_by, id) rn
          FROM node_tree WHERE win_node_id=${f} AND node_type='group' AND is_open=1) fr
    JOIN (SELECT id, title, ROW_NUMBER() OVER (PARTITION BY title ORDER BY order_by, id) rn
          FROM node_tree WHERE win_node_id=${c} AND node_type='group'
            AND (chrome_id IS NULL OR chrome_id NOT IN (SELECT chrome_id FROM tmp_live WHERE kind='grp'))
         ) ca ON ca.title IS fr.title AND ca.rn = fr.rn;

    INSERT OR IGNORE INTO node_tag (node_id, tag_id)
      SELECT p.cand_id, nt.tag_id FROM node_tag nt JOIN tmp_pairs p ON p.fresh_id = nt.node_id;

    DROP TABLE IF EXISTS tmp_doomed;
    CREATE TEMP TABLE tmp_doomed AS
      SELECT fresh_id id FROM tmp_pairs UNION SELECT fresh_id FROM tmp_gpairs;
  `);
  spliceOutDoomed();
  const base = sqlQuery(`SELECT COALESCE(MAX(order_by),-1)+1 b FROM node WHERE parent_id=?`, [c])[0].b;
  const fw = sqlQuery(`SELECT chrome_id, win_rect, relicons FROM node WHERE id=${f}`)[0] ?? {};
  sqlExec(`
    UPDATE node SET
      chrome_id   = (SELECT chrome_id FROM tmp_pairs p WHERE p.cand_id = node.id),
      is_open     = 1,
      position    = (SELECT position  FROM tmp_pairs p WHERE p.cand_id = node.id),
      is_pinned   = (SELECT is_pinned FROM tmp_pairs p WHERE p.cand_id = node.id),
      title       = COALESCE((SELECT title       FROM tmp_pairs p WHERE p.cand_id = node.id), title),
      favicon_url = COALESCE((SELECT favicon_url FROM tmp_pairs p WHERE p.cand_id = node.id), favicon_url),
      updated_at  = datetime('now')
    WHERE id IN (SELECT cand_id FROM tmp_pairs);

    UPDATE node SET
      chrome_id    = (SELECT chrome_id    FROM tmp_gpairs p WHERE p.cand_id = node.id),
      is_open      = 1,
      color_active = COALESCE((SELECT color_active FROM tmp_gpairs p WHERE p.cand_id = node.id), color_active),
      is_collapsed = COALESCE((SELECT is_collapsed FROM tmp_gpairs p WHERE p.cand_id = node.id), is_collapsed),
      updated_at   = datetime('now')
    WHERE id IN (SELECT cand_id FROM tmp_gpairs);

    UPDATE node SET parent_id=${c}, order_by = order_by + ${Math.trunc(+base)} WHERE parent_id=${f};

    INSERT OR IGNORE INTO win_auto_tag (win_node_id, tag_id)
      SELECT ${c}, tag_id FROM win_auto_tag WHERE win_node_id=${f};
    DELETE FROM win_auto_tag WHERE win_node_id=${f};
    DELETE FROM node_tag WHERE node_id=${f};
    DELETE FROM node WHERE id=${f};
    DROP TABLE tmp_pairs;
    DROP TABLE tmp_gpairs;
  `);
  sqlRun(
    `UPDATE node SET is_open=1, chrome_id=?, win_rect=COALESCE(?, win_rect), relicons=COALESCE(?, relicons), updated_at=datetime('now')
     WHERE id=?`,
    [fw.chrome_id ?? null, fw.win_rect ?? null, fw.relicons ?? null, c]
  );
}

// ── Window-close helper (used by onWindowRemoved and resync) ─────────────────

// A window survives closing when it, a descendant tab, or a textnote is saved;
// survivors close in place (chrome ids cleared) and the win is promoted to saved —
// otherwise the whole subtree is dropped. Tabs whose Chrome tab is still alive in
// another window (legal tree/Chrome divergence) are never touched here: their own
// per-tab events own them, and they splice up to the nearest kept ancestor.
async function closeWindowNode(winNodeId) {
  const id = Math.trunc(+winNodeId);
  const live = (await chrome.tabs.query({}).catch(() => []))
    .map(t => Math.trunc(+t.id)).filter(Number.isFinite).join(',') || '-1';
  const notLive = `(node_type != 'tab' OR chrome_id IS NULL OR chrome_id NOT IN (${live}))`;
  const keep = sqlQuery(
    `SELECT 1 FROM node_tree WHERE (win_node_id=? OR id=?) AND (is_saved=1 OR node_type='textnote') LIMIT 1`,
    [id, id]
  ).length > 0;
  sqlExec(`
    DROP TABLE IF EXISTS tmp_doomed;
    CREATE TEMP TABLE tmp_doomed AS
      SELECT id FROM node_tree WHERE win_node_id=${id} AND ${notLive}
        ${keep ? `AND is_saved=0 AND node_type IN ('tab','group')` : `UNION SELECT ${id}`};
  `);
  spliceOutDoomed();
  if (keep) {
    sqlExec(`
      UPDATE node SET is_open=0, chrome_id=NULL, updated_at=datetime('now')
        WHERE is_open=1 AND ${notLive}
          AND (id=${id} OR id IN (SELECT id FROM node_tree WHERE win_node_id=${id}));
      UPDATE node SET is_saved=1 WHERE id=${id};
    `);
  }
}

// ── Badge ─────────────────────────────────────────────────────────────────────

export async function updateBadge() {
  await ensureDb();
  const rows = sqlQuery(`SELECT COUNT(*) c FROM node WHERE node_type='tab' AND is_open=1`);
  const count = rows[0]?.c ?? 0;
  chrome.action.setBadgeBackgroundColor({ color: '#7c9ef8' });
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
}

// ── Window events ─────────────────────────────────────────────────────────────

async function onWindowCreated(win) {
  await ensureDb();
  const pending = bgState.pendingWinAdopt;
  bgState.pendingWinAdopt = null;
  const rect     = `${win.left}_${win.top}_${win.width}_${win.height}`;
  const relicons = win.type ?? 'normal';
  const existingId = nodeDbId(win.id, 'win')
    ?? (pending && Date.now() - pending.ts < 5000 ? pending.nodeId : null);
  if (existingId != null) {
    sqlRun(
      `UPDATE node SET is_open=1, chrome_id=?, win_rect=?, relicons=?, updated_at=datetime('now') WHERE id=?`,
      [win.id, rect, relicons, existingId]
    );
  } else {
    const sid = sessionId();
    sqlInsert(
      `INSERT INTO node (node_type, is_open, is_saved, chrome_id, win_rect, relicons, parent_id, order_by)
       VALUES ('win',1,0,?,?,?,?,(SELECT COALESCE(MAX(order_by),-1)+1 FROM node WHERE parent_id=?))`,
      [win.id, rect, relicons, sid, sid]
    );
    scheduleAdoption();
  }
  await persistDb();
  await updateBadge();
}

async function onWindowRemoved(winId) {
  await ensureDb();
  const { popupWinId } = await chrome.storage.session.get('popupWinId');
  if (winId === popupWinId) {
    await chrome.storage.session.remove('popupWinId');
    return;
  }
  const winNodeId = nodeDbId(winId, 'win');
  if (!winNodeId) return;
  await closeWindowNode(winNodeId);
  await persistDb();
  await updateBadge();
}

// ── Tab events ────────────────────────────────────────────────────────────────

// Three adoption paths run before a plain insert:
//   adoptedTabIds  — bulk reopen already bound the node, nothing to do
//   pendingAdopt   — tree.js asked to reopen a specific saved node; graft the chrome
//                    identity onto it in place (parent, order and is_saved untouched)
//   silent adopt   — a recently saved, closed tab with the same URL under this same
//                    window: Ctrl+Shift+T style restores re-attach instead of duplicating
// New nodes parent to their opener tab, else their group, else the parent of the
// preceding tab, else the window; window auto-tags then all is_auto rules apply to them.
async function onTabCreated(tab) {
  await ensureDb();

  if (bgState.adoptedTabIds.has(tab.id)) {
    bgState.adoptedTabIds.delete(tab.id);
    return;
  }

  const url = tab.pendingUrl || tab.url || '';
  const winNodeId = nodeDbId(tab.windowId, 'win');

  if (bgState.pendingAdopt && (Date.now() - bgState.pendingAdopt.ts < 5000)) {
    const { nodeId } = bgState.pendingAdopt;
    bgState.pendingAdopt = null;
    sqlRun(
      `UPDATE node SET chrome_id=?, is_open=1, title=COALESCE(NULLIF(?,''), title), url=COALESCE(NULLIF(?,''), url),
              domain=COALESCE(?, domain), favicon_url=COALESCE(NULLIF(?,''), favicon_url),
              position=?, updated_at=datetime('now') WHERE id=?`,
      [tab.id, tab.title ?? '', url, extractDomain(url), tab.favIconUrl ?? '', tab.index ?? 0, nodeId]
    );
    await persistDb();
    return;
  }

  if (url && winNodeId) {
    const hours = cfgNum('adopt_candidate_hours', 48);
    sqlRun(
      `UPDATE node SET chrome_id=:cid, is_open=1, position=:pos, updated_at=datetime('now')
       WHERE id = (SELECT id FROM node_tree
                   WHERE win_node_id=:win AND node_type='tab' AND is_open=0 AND is_saved=1 AND url=:url
                     AND updated_at >= datetime('now', :cut)
                   ORDER BY updated_at DESC LIMIT 1)`,
      { ':cid': tab.id, ':pos': tab.index ?? 0, ':win': winNodeId, ':url': url, ':cut': `-${hours} hours` }
    );
    if (rowsModified()) {
      await persistDb();
      await updateBadge();
      return;
    }
  }

  let pid = null;
  if (tab.openerTabId) pid = nodeDbId(tab.openerTabId, 'tab');
  if (pid == null && tab.groupId !== -1) pid = nodeDbId(tab.groupId, 'group');
  if (pid == null && tab.index > 0) {
    const [preceding] = await chrome.tabs.query({ windowId: tab.windowId, index: tab.index - 1 });
    if (preceding) {
      const row = sqlQuery(
        `SELECT parent_id FROM node WHERE node_type='tab' AND chrome_id=? LIMIT 1`,
        [preceding.id]
      )[0];
      if (row?.parent_id != null) pid = row.parent_id;
    }
  }
  if (pid == null) pid = winNodeId;

  const existingId = nodeDbId(tab.id, 'tab');
  let newTabId;
  if (existingId) {
    sqlRun(
      `UPDATE node SET is_open=1, is_pinned=?, title=?, url=?, domain=?, favicon_url=?, position=?, updated_at=datetime('now') WHERE id=?`,
      [tab.pinned ? 1 : 0, tab.title ?? '', url, extractDomain(url), tab.favIconUrl ?? '', tab.index ?? 0, existingId]
    );
    newTabId = existingId;
  } else {
    newTabId = sqlInsert(
      `INSERT INTO node (node_type, is_open, is_saved, is_pinned, chrome_id, title, url, domain, favicon_url, position, order_by, parent_id)
       VALUES ('tab',1,0,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(order_by),-1)+1 FROM node WHERE parent_id IS ?),?)`,
      [tab.pinned ? 1 : 0, tab.id, tab.title ?? '', url, extractDomain(url),
       tab.favIconUrl ?? '', tab.index ?? 0, pid ?? null, pid ?? null]
    );
  }

  if (winNodeId != null) {
    sqlRun(
      `INSERT OR IGNORE INTO node_tag (node_id, tag_id) SELECT ?, tag_id FROM win_auto_tag WHERE win_node_id=?`,
      [newTabId, winNodeId]
    );
    if (sqlQuery(`SELECT 1 FROM node WHERE id=? AND created_at >= datetime('now','-3 minutes')`, [winNodeId]).length) {
      scheduleAdoption();
    }
  }
  await applyAutoRules(newTabId);
  await syncWindowPositions(tab.windowId);
  await persistDb();
  await updateBadge();
}

// Saved tabs close in place (is_saved is sticky — rules already ran at add/refresh
// time); unsaved tabs are removed with their children spliced onto their parent.
async function onTabRemoved(tabId, info) {
  await ensureDb();
  const row = sqlQuery(
    `SELECT id, parent_id, is_saved FROM node WHERE node_type='tab' AND chrome_id=? LIMIT 1`,
    [tabId]
  )[0];
  if (!row) return;

  if (row.is_saved) {
    sqlRun(`UPDATE node SET is_open=0, chrome_id=NULL, updated_at=datetime('now') WHERE id=?`, [row.id]);
  } else {
    sqlRun(`UPDATE node SET parent_id=? WHERE parent_id=?`, [row.parent_id, row.id]);
    sqlRun(`DELETE FROM node_tag WHERE node_id=?`, [row.id]);
    sqlRun(`DELETE FROM node WHERE id=?`, [row.id]);
  }

  if (!info?.isWindowClosing) {
    const winChromeId = getWinChromeId(row.parent_id);
    if (winChromeId) await syncWindowPositions(winChromeId);
  }
  if (row.parent_id != null) renumberOrderBy([row.parent_id]);
  await persistDb();
  await updateBadge();
}

async function onTabMoved(tabId, moveInfo) {
  await ensureDb();
  const now = Date.now();
  for (const [id, ts] of bgState.movingTabIds) {
    if (now - ts > 5000) bgState.movingTabIds.delete(id);
  }
  if (bgState.movingTabIds.has(tabId)) {
    bgState.movingTabIds.delete(tabId);
    await syncWindowPositions(moveInfo.windowId);
  } else {
    await chromeReparentTab(tabId);
  }
  await persistDb();
}

// Cross-window drags fire onDetached/onAttached (never onMoved). Detach only refreshes
// the old window's positions and must NOT consume the movingTabIds sentinel — the
// attach that follows needs it to tell our own cascades from user-initiated drags.
async function onTabDetached(_tabId, info) {
  await ensureDb();
  await syncWindowPositions(info.oldWindowId);
  await persistDb();
}

async function onTabAttached(tabId, info) {
  await ensureDb();
  if (bgState.movingTabIds.has(tabId)) {
    bgState.movingTabIds.delete(tabId);
    await syncWindowPositions(info.newWindowId);
  } else {
    await chromeReparentTab(tabId);
  }
  await persistDb();
}

async function onTabUpdated(tabId, changeInfo, tab) {
  await ensureDb();
  const id = nodeDbId(tabId, 'tab');
  if (id == null) return;

  if (changeInfo.groupId !== undefined && !bgState.movingTabIds.has(tabId)) {
    await chromeReparentTab(tabId);
  }
  if (changeInfo.pinned !== undefined) {
    sqlRun(`UPDATE node SET is_pinned=?, updated_at=datetime('now') WHERE id=?`, [changeInfo.pinned ? 1 : 0, id]);
  }
  if (changeInfo.url || changeInfo.title || changeInfo.favIconUrl) {
    const url = tab.url ?? '';
    sqlRun(
      `UPDATE node SET title=?, url=?, domain=?, favicon_url=?, updated_at=datetime('now') WHERE id=?`,
      [tab.title ?? '', url, extractDomain(url), tab.favIconUrl ?? '', id]
    );
    if (changeInfo.url || changeInfo.title) await applyAutoRules(id);
  }
  await persistDb();
}

// ── Tab group events ──────────────────────────────────────────────────────────

export async function upsertTabGroup(group) {
  await ensureDb();
  const winNodeId = nodeDbId(group.windowId, 'win');
  if (!winNodeId) return;
  const existingId = nodeDbId(group.id, 'group');
  const title = group.title ?? '', color = group.color ?? null, collapsed = group.collapsed ? 1 : 0;
  if (existingId) {
    sqlRun(
      `UPDATE node SET parent_id=?, title=?, color_active=?, is_collapsed=?, is_open=1, updated_at=datetime('now') WHERE id=?`,
      [winNodeId, title, color, collapsed, existingId]
    );
  } else {
    sqlInsert(
      `INSERT INTO node (node_type, chrome_id, parent_id, title, color_active, is_collapsed, is_open, is_saved, order_by)
       VALUES ('group',?,?,?,?,?,1,0,(SELECT COALESCE(MAX(order_by),-1)+1 FROM node WHERE parent_id=?))`,
      [group.id, winNodeId, title, color, collapsed, winNodeId]
    );
  }
  await persistDb();
}

async function onTabGroupRemoved(group) {
  await ensureDb();
  const groupNode = sqlQuery(
    `SELECT id, parent_id FROM node WHERE node_type='group' AND chrome_id=? LIMIT 1`,
    [group.id]
  )[0];
  if (!groupNode) return;
  sqlRun(`UPDATE node SET parent_id=? WHERE parent_id=?`, [groupNode.parent_id, groupNode.id]);
  sqlRun(`DELETE FROM node WHERE id=?`, [groupNode.id]);
  if (groupNode.parent_id != null) renumberOrderBy([groupNode.parent_id]);
  await persistDb();
}

// ── Listeners ─────────────────────────────────────────────────────────────────

function guard(fn) {
  return (...args) => fn(...args).catch(e => console.error(fn.name + ':', e));
}

chrome.windows.onCreated.addListener(guard(onWindowCreated));
chrome.windows.onRemoved.addListener(guard(onWindowRemoved));
chrome.tabs.onCreated.addListener(guard(onTabCreated));
chrome.tabs.onRemoved.addListener(guard(onTabRemoved));
chrome.tabs.onUpdated.addListener(guard(onTabUpdated));
chrome.tabs.onMoved.addListener(guard(onTabMoved));
chrome.tabs.onDetached.addListener(guard(onTabDetached));
chrome.tabs.onAttached.addListener(guard(onTabAttached));
chrome.tabGroups.onCreated.addListener(guard(upsertTabGroup));
chrome.tabGroups.onUpdated.addListener(guard(upsertTabGroup));
chrome.tabGroups.onRemoved.addListener(guard(onTabGroupRemoved));
