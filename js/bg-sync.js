import {
  ensureDb, persistDb, sqlQuery, sqlRun, sqlInsert, sqlExec,
  extractDomain, buildSearchWhere, bgState,
  getRecursiveOpenChildren, getWinChromeId,
} from './bg-db.js';

function nodeDbId(chromeId, type) {
  return sqlQuery(
    `SELECT id FROM node WHERE chrome_id=? AND node_type=? LIMIT 1`,
    [chromeId, type]
  )[0]?.id ?? null;
}

// ── Cascade helpers ───────────────────────────────────────────────────────────

export async function cascadeChildrenToChrome(nodeId, startIndex, windowId) {
  const children = getRecursiveOpenChildren(nodeId);
  let idx = startIndex;
  for (const child of children) {
    bgState.movingTabIds.set(child.chrome_id, Date.now());
    try { await chrome.tabs.move(child.chrome_id, { windowId, index: idx }); } catch {}
    idx++;
  }
}

async function syncWindowPositions(winChromeId) {
  const tabs = await chrome.tabs.query({ windowId: winChromeId });
  for (const tab of tabs) {
    sqlRun(
      `UPDATE node SET position=?, updated_at=datetime('now') WHERE node_type='tab' AND chrome_id=? AND is_open=1`,
      [tab.index, tab.id]
    );
  }
}

// ── resync ────────────────────────────────────────────────────────────────────

export async function resync() {
  await ensureDb();
  const [wins, groups] = await Promise.all([
    chrome.windows.getAll({ populate: true }),
    chrome.tabGroups.query({}),
  ]);

  // ── Build temp table ────────────────────────────────────────────────────────
  sqlExec(`DROP TABLE IF EXISTS tmp_node`);
  sqlExec(`
    CREATE TEMP TABLE tmp_node (
      id               INTEGER DEFAULT NULL,
      chrome_id        INTEGER NOT NULL,
      node_type        TEXT    NOT NULL,
      parent_chrome_id INTEGER DEFAULT NULL,
      parent_node_type TEXT    DEFAULT NULL,
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
    )
  `);

  for (const win of wins) {
    sqlRun(
      `INSERT INTO tmp_node (chrome_id, node_type, relicons, win_rect) VALUES (?, 'win', ?, ?)`,
      [win.id, win.type ?? 'normal', `${win.left}_${win.top}_${win.width}_${win.height}`]
    );
  }
  for (const group of groups) {
    sqlRun(
      `INSERT INTO tmp_node (chrome_id, node_type, parent_chrome_id, parent_node_type, title, color_active, is_collapsed)
       VALUES (?, 'group', ?, 'win', ?, ?, ?)`,
      [group.id, group.windowId, group.title ?? '', group.color ?? null, group.collapsed ? 1 : 0]
    );
  }
  for (const win of wins) {
    for (const tab of (win.tabs ?? [])) {
      const url = tab.url ?? '';
      sqlRun(
        `INSERT INTO tmp_node
           (chrome_id, node_type, parent_chrome_id, parent_node_type, position, is_pinned, title, url, domain, favicon_url)
         VALUES (?, 'tab', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tab.id,
         tab.groupId !== -1 ? tab.groupId : win.id,
         tab.groupId !== -1 ? 'group' : 'win',
         tab.index ?? 0, tab.pinned ? 1 : 0,
         tab.title ?? '', url, extractDomain(url), tab.favIconUrl ?? '']
      );
    }
  }

  // ── Match tmp rows to existing node rows ────────────────────────────────────
  sqlExec(`
    UPDATE tmp_node SET id = (
      SELECT n.id FROM node n
      WHERE n.chrome_id = tmp_node.chrome_id AND n.node_type = tmp_node.node_type
    )
  `);

  // ── Update existing matched nodes (preserve parent_id and order_by) ─────────
  sqlExec(`
    UPDATE node SET
      position     = (SELECT t.position     FROM tmp_node t WHERE t.id = node.id),
      is_open      = 1,
      is_saved     = 0,
      is_pinned    = (SELECT t.is_pinned    FROM tmp_node t WHERE t.id = node.id),
      is_collapsed = (SELECT t.is_collapsed FROM tmp_node t WHERE t.id = node.id),
      title        = COALESCE((SELECT t.title       FROM tmp_node t WHERE t.id = node.id), node.title),
      url          = COALESCE((SELECT t.url         FROM tmp_node t WHERE t.id = node.id), node.url),
      domain       = COALESCE((SELECT t.domain      FROM tmp_node t WHERE t.id = node.id), node.domain),
      favicon_url  = COALESCE((SELECT t.favicon_url FROM tmp_node t WHERE t.id = node.id), node.favicon_url),
      color_active = COALESCE((SELECT t.color_active FROM tmp_node t WHERE t.id = node.id), node.color_active),
      relicons     = COALESCE((SELECT t.relicons    FROM tmp_node t WHERE t.id = node.id), node.relicons),
      win_rect     = COALESCE((SELECT t.win_rect    FROM tmp_node t WHERE t.id = node.id), node.win_rect),
      updated_at   = datetime('now')
    WHERE id IN (SELECT id FROM tmp_node WHERE id IS NOT NULL)
  `);

  // ── Insert new wins ─────────────────────────────────────────────────────────
  sqlExec(`
    INSERT INTO node (chrome_id, node_type, is_open, is_saved, relicons, win_rect, order_by, updated_at)
    SELECT t.chrome_id, 'win', 1, 0, t.relicons, t.win_rect,
           COALESCE((SELECT MAX(n2.order_by)+1 FROM node n2 WHERE n2.parent_id IS NULL), 0),
           datetime('now')
    FROM tmp_node t WHERE t.id IS NULL AND t.node_type = 'win'
  `);
  sqlExec(`
    UPDATE tmp_node SET id = (
      SELECT n.id FROM node n WHERE n.chrome_id = tmp_node.chrome_id AND n.node_type = tmp_node.node_type
    ) WHERE id IS NULL
  `);

  // ── Insert new groups ───────────────────────────────────────────────────────
  sqlExec(`
    INSERT INTO node (chrome_id, node_type, is_open, is_saved, title, color_active, is_collapsed, parent_id, order_by, updated_at)
    SELECT t.chrome_id, 'group', 1, 0, t.title, t.color_active, t.is_collapsed,
           (SELECT n.id FROM node n WHERE n.chrome_id = t.parent_chrome_id AND n.node_type = 'win'),
           COALESCE((SELECT MAX(n2.order_by)+1 FROM node n2
             WHERE n2.parent_id = (SELECT n.id FROM node n WHERE n.chrome_id = t.parent_chrome_id AND n.node_type = 'win')), 0),
           datetime('now')
    FROM tmp_node t WHERE t.id IS NULL AND t.node_type = 'group'
  `);
  sqlExec(`
    UPDATE tmp_node SET id = (
      SELECT n.id FROM node n WHERE n.chrome_id = tmp_node.chrome_id AND n.node_type = tmp_node.node_type
    ) WHERE id IS NULL
  `);

  // ── Insert new tabs (order_by seeded from tab.index) ────────────────────────
  sqlExec(`
    INSERT INTO node
      (chrome_id, node_type, is_open, is_saved, position, is_pinned, title, url, domain, favicon_url, parent_id, order_by, updated_at)
    SELECT t.chrome_id, 'tab', 1, 0, t.position, t.is_pinned,
           t.title, t.url, t.domain, t.favicon_url,
           (SELECT n.id FROM node n WHERE n.chrome_id = t.parent_chrome_id AND n.node_type = t.parent_node_type),
           t.position,
           datetime('now')
    FROM tmp_node t WHERE t.id IS NULL AND t.node_type = 'tab'
  `);

  // ── Mark stale open tabs as saved ───────────────────────────────────────────
  sqlExec(`
    UPDATE node SET is_open=0, is_saved=1, chrome_id=NULL, updated_at=datetime('now')
    WHERE node_type='tab' AND is_open=1 AND chrome_id IS NOT NULL
      AND id NOT IN (SELECT id FROM tmp_node WHERE id IS NOT NULL AND node_type='tab')
  `);

  // ── Reparent children of stale groups, then delete the groups ───────────────
  sqlExec(`
    UPDATE node SET parent_id = (SELECT g.parent_id FROM node g WHERE g.id = node.parent_id)
    WHERE parent_id IN (
      SELECT id FROM node WHERE node_type='group' AND is_open=1 AND chrome_id IS NOT NULL
        AND id NOT IN (SELECT id FROM tmp_node WHERE id IS NOT NULL AND node_type='group')
    )
  `);
  sqlExec(`
    DELETE FROM node WHERE node_type='group' AND is_open=1 AND chrome_id IS NOT NULL
      AND id NOT IN (SELECT id FROM tmp_node WHERE id IS NOT NULL AND node_type='group')
  `);

  // ── Remove stale windows ────────────────────────────────────────────────────
  const staleWins = sqlQuery(`
    SELECT id FROM node WHERE node_type='win' AND is_open=1 AND chrome_id IS NOT NULL
      AND id NOT IN (SELECT id FROM tmp_node WHERE id IS NOT NULL AND node_type='win')
  `);
  for (const row of staleWins) {
    closeWindowNode(row.id);
  }

  sqlExec(`DROP TABLE IF EXISTS tmp_node`);
  await persistDb();
}

export async function initialize() {
  await resync();
  await updateBadge();
  console.log('TabSQL initialized');
}

// ── Window-close helper (used by onWindowRemoved and resync) ─────────────────

function closeWindowNode(winNodeId) {
  const hasSaved = sqlQuery(
    `SELECT 1 FROM node_tree WHERE win_node_id=? AND is_saved=1 LIMIT 1`,
    [winNodeId]
  ).length > 0;

  if (hasSaved) {
    // Reparent saved descendants of open parents to the win node before deleting open nodes
    sqlRun(`
      UPDATE node SET parent_id=?
      WHERE is_saved=1
        AND parent_id IN (SELECT id FROM node_tree WHERE win_node_id=? AND is_saved=0)
    `, [winNodeId, winNodeId]);
    sqlRun(
      `DELETE FROM node WHERE id IN (SELECT id FROM node_tree WHERE win_node_id=? AND is_saved=0)`,
      [winNodeId]
    );
    sqlRun(
      `UPDATE node SET is_saved=1, is_open=0, chrome_id=NULL, updated_at=datetime('now') WHERE id=?`,
      [winNodeId]
    );
  } else {
    sqlRun(
      `DELETE FROM node WHERE id IN (SELECT id FROM node_tree WHERE win_node_id=?)`,
      [winNodeId]
    );
    sqlRun(`DELETE FROM node WHERE id=?`, [winNodeId]);
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
  const existingId = nodeDbId(win.id, 'win');
  const rect    = `${win.left}_${win.top}_${win.width}_${win.height}`;
  const relicons = win.type ?? 'normal';
  if (existingId) {
    sqlRun(
      `UPDATE node SET is_open=1, win_rect=?, relicons=?, updated_at=datetime('now') WHERE id=?`,
      [rect, relicons, existingId]
    );
  } else {
    const orderBy = (sqlQuery(`SELECT MAX(order_by) m FROM node WHERE parent_id IS NULL`)[0]?.m ?? -1) + 1;
    sqlInsert(
      `INSERT INTO node (node_type, is_open, is_saved, chrome_id, win_rect, relicons, order_by)
       VALUES ('win',1,0,?,?,?,?)`,
      [win.id, rect, relicons, orderBy]
    );
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
  closeWindowNode(winNodeId);
  await persistDb();
  await updateBadge();
}

// ── Tab events ────────────────────────────────────────────────────────────────

async function onTabCreated(tab) {
  await ensureDb();

  if (bgState.adoptedTabIds.has(tab.id)) {
    bgState.adoptedTabIds.delete(tab.id);
    return;
  }

  if (bgState.pendingAdopt && (Date.now() - bgState.pendingAdopt.ts < 5000)) {
    const { nodeId } = bgState.pendingAdopt;
    bgState.pendingAdopt = null;
    const savedPos = sqlQuery('SELECT position, order_by FROM node WHERE id=?', [nodeId])[0];
    const pid = nodeDbId(tab.windowId, 'win');
    const url = tab.url ?? '';
    sqlRun(
      `UPDATE node SET chrome_id=?, is_open=1, parent_id=?, title=?, url=?, domain=?, favicon_url=?, position=?, updated_at=datetime('now') WHERE id=?`,
      [tab.id, pid, tab.title ?? '', url, extractDomain(url), tab.favIconUrl ?? '', tab.index ?? 0, nodeId]
    );
    await persistDb();
    if (savedPos && savedPos.position >= 0 && savedPos.position !== tab.index) {
      try { await chrome.tabs.move(tab.id, { index: savedPos.position }); } catch {}
    }
    return;
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
  if (pid == null) pid = nodeDbId(tab.windowId, 'win');

  const orderBy = (sqlQuery(`SELECT MAX(order_by) m FROM node WHERE parent_id=?`, [pid ?? null])[0]?.m ?? -1) + 1;
  const url    = tab.url        ?? '';
  const tpinned = tab.pinned ? 1 : 0;
  const existingId = nodeDbId(tab.id, 'tab');
  let newTabId;
  if (existingId) {
    sqlRun(
      `UPDATE node SET is_open=1, is_pinned=?, title=?, url=?, domain=?, favicon_url=?, position=?, order_by=?, updated_at=datetime('now') WHERE id=?`,
      [tpinned, tab.title ?? '', url, extractDomain(url), tab.favIconUrl ?? '', tab.index ?? 0, orderBy, existingId]
    );
    newTabId = existingId;
  } else {
    newTabId = sqlInsert(
      `INSERT INTO node (node_type, is_open, is_saved, is_pinned, chrome_id, title, url, domain, favicon_url, position, order_by, parent_id)
       VALUES ('tab',1,0,?,?,?,?,?,?,?,?,?)`,
      [tpinned, tab.id, tab.title ?? '', url, extractDomain(url), tab.favIconUrl ?? '', tab.index ?? 0, orderBy, pid ?? null]
    );
  }

  await syncWindowPositions(tab.windowId);
  await persistDb();

  const winId = nodeDbId(tab.windowId, 'win');
  if (winId) {
    const autoTags = sqlQuery('SELECT tag_id FROM win_auto_tag WHERE win_node_id=?', [winId]);
    for (const at of autoTags) {
      sqlRun('INSERT OR IGNORE INTO node_tag (node_id, tag_id) VALUES (?,?)', [newTabId, at.tag_id]);
    }
    if (autoTags.length) await persistDb();
  }
  await updateBadge();
}

async function onTabRemoved(tabId, _info) {
  await ensureDb();
  const row = sqlQuery(`SELECT * FROM node WHERE node_type='tab' AND chrome_id=? LIMIT 1`, [tabId])[0];
  if (!row) return;

  const saveRules = sqlQuery(`SELECT * FROM action_rule WHERE action_type='save_on_close' AND is_auto=1`);
  let shouldSave = false;
  for (const rule of saveRules) {
    if (rule.condition_type === 'search') {
      const { where, params } = buildSearchWhere(rule.condition);
      const match = sqlQuery(`SELECT id FROM node WHERE id=? AND (${where})`, [row.id, ...params]);
      if (match.length) { shouldSave = true; break; }
    } else if (rule.condition_type === 'sql') {
      try {
        const result = sqlQuery(rule.condition);
        if (result.some(r => r.id === row.id)) { shouldSave = true; break; }
      } catch {}
    }
  }

  if (shouldSave) {
    sqlRun(`UPDATE node SET is_saved=1, is_open=0, chrome_id=NULL, updated_at=datetime('now') WHERE id=?`, [row.id]);
  } else {
    sqlRun(`UPDATE node SET parent_id=? WHERE parent_id=?`, [row.parent_id, row.id]);
    sqlRun('DELETE FROM node WHERE id=?', [row.id]);
  }

  const winChromeId = getWinChromeId(row.parent_id);
  if (winChromeId) await syncWindowPositions(winChromeId);

  await persistDb();
  await updateBadge();
}

async function onTabMoved(tabId, moveInfo) {
  await ensureDb();
  const now = Date.now();

  // Expire stale sentinel entries
  for (const [id, ts] of bgState.movingTabIds) {
    if (now - ts > 5000) bgState.movingTabIds.delete(id);
  }

  if (bgState.movingTabIds.has(tabId)) {
    // Programmatic move from our own cascade — just track the new Chrome index
    bgState.movingTabIds.delete(tabId);
    sqlRun(
      `UPDATE node SET position=?, updated_at=datetime('now') WHERE node_type='tab' AND chrome_id=? AND is_open=1`,
      [moveInfo.toIndex, tabId]
    );
    await persistDb();
    return;
  }

  // Chrome-user-initiated move — update position and cascade open children
  sqlRun(
    `UPDATE node SET position=?, updated_at=datetime('now') WHERE node_type='tab' AND chrome_id=? AND is_open=1`,
    [moveInfo.toIndex, tabId]
  );

  const movedNode = sqlQuery(
    `SELECT id FROM node WHERE node_type='tab' AND chrome_id=? AND is_open=1 LIMIT 1`,
    [tabId]
  )[0];
  if (movedNode) {
    await cascadeChildrenToChrome(movedNode.id, moveInfo.toIndex + 1, moveInfo.windowId);
  }
  await persistDb();
}

async function onTabUpdated(tabId, changeInfo, tab) {
  await ensureDb();

  if (changeInfo.groupId !== undefined) {
    const id = nodeDbId(tabId, 'tab');
    if (id != null) {
      const newParentId = changeInfo.groupId !== -1
        ? (nodeDbId(changeInfo.groupId, 'group') ?? nodeDbId(tab.windowId, 'win'))
        : nodeDbId(tab.windowId, 'win');
      if (newParentId) {
        sqlRun(`UPDATE node SET parent_id=?, updated_at=datetime('now') WHERE id=?`, [newParentId, id]);
      }
      await persistDb();
    }
  }

  if (changeInfo.pinned !== undefined) {
    const id = nodeDbId(tabId, 'tab');
    if (id != null) {
      sqlRun(
        `UPDATE node SET is_pinned=?, updated_at=datetime('now') WHERE id=?`,
        [changeInfo.pinned ? 1 : 0, id]
      );
      await persistDb();
    }
  }

  if (!changeInfo.url && !changeInfo.title && !changeInfo.favIconUrl) return;
  const id = nodeDbId(tabId, 'tab');
  if (id == null) return;
  const url = tab.url ?? '';
  sqlRun(
    `UPDATE node SET title=?, url=?, domain=?, favicon_url=?, updated_at=datetime('now') WHERE id=?`,
    [tab.title ?? '', url, extractDomain(url), tab.favIconUrl ?? '', id]
  );
  await persistDb();
}

// ── Tab group events ──────────────────────────────────────────────────────────

async function onTabGroupCreated(group) {
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
    const orderBy = (sqlQuery(`SELECT MAX(order_by) m FROM node WHERE parent_id=?`, [winNodeId])[0]?.m ?? -1) + 1;
    sqlInsert(
      `INSERT INTO node (node_type, chrome_id, parent_id, title, color_active, is_collapsed, is_open, is_saved, order_by)
       VALUES ('group',?,?,?,?,?,1,0,?)`,
      [group.id, winNodeId, title, color, collapsed, orderBy]
    );
  }
  await persistDb();
}

async function onTabGroupUpdated(group) {
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
    const orderBy = (sqlQuery(`SELECT MAX(order_by) m FROM node WHERE parent_id=?`, [winNodeId])[0]?.m ?? -1) + 1;
    sqlInsert(
      `INSERT INTO node (node_type, chrome_id, parent_id, title, color_active, is_collapsed, is_open, is_saved, order_by)
       VALUES ('group',?,?,?,?,?,1,0,?)`,
      [group.id, winNodeId, title, color, collapsed, orderBy]
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
chrome.tabGroups.onCreated.addListener(guard(onTabGroupCreated));
chrome.tabGroups.onUpdated.addListener(guard(onTabGroupUpdated));
chrome.tabGroups.onRemoved.addListener(guard(onTabGroupRemoved));
