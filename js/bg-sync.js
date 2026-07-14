import { ensureDb, persistDb, sqlQuery, sqlRun, upsertNode, buildSearchWhere, bgState } from './bg-db.js';

async function upsertWin(chromeWin) {
  await ensureDb();
  const existing = sqlQuery(
    `SELECT id FROM node WHERE chrome_id=? AND node_type='win' LIMIT 1`,
    [chromeWin.id]
  )[0];
  const node = {
    node_type: 'win',
    is_open:   1,
    is_saved:  0,
    chrome_id: chromeWin.id,
    win_rect:  `${chromeWin.left}_${chromeWin.top}_${chromeWin.width}_${chromeWin.height}`,
    relicons:  chromeWin.type ?? 'normal',
  };
  if (existing) node.id = existing.id;
  const id = upsertNode(node);
  await persistDb();
  return id;
}

async function upsertTab(chromeTab, parentDbId) {
  await ensureDb();
  const existing = sqlQuery(
    `SELECT id FROM node WHERE chrome_id=? AND node_type='tab' LIMIT 1`,
    [chromeTab.id]
  )[0];
  const node = {
    node_type:   'tab',
    is_open:     1,
    is_saved:    0,
    chrome_id:   chromeTab.id,
    title:       chromeTab.title      ?? '',
    url:         chromeTab.url        ?? '',
    favicon_url: chromeTab.favIconUrl ?? '',
    position:    chromeTab.index      ?? 0,
  };
  if (existing) {
    node.id = existing.id;
  } else if (parentDbId != null) {
    node.parent_id = parentDbId;
  }
  const id = upsertNode(node);
  await persistDb();
  return id;
}

async function winDbId(chromeWinId) {
  await ensureDb();
  return sqlQuery(`SELECT id FROM node WHERE node_type='win' AND chrome_id=? LIMIT 1`, [chromeWinId])[0]?.id ?? null;
}

async function tabDbId(chromeTabId) {
  await ensureDb();
  return sqlQuery(`SELECT id FROM node WHERE node_type='tab' AND chrome_id=? LIMIT 1`, [chromeTabId])[0]?.id ?? null;
}

function tabGroupDbId(chromeGroupId) {
  return sqlQuery(`SELECT id FROM node WHERE node_type='group' AND chrome_id=? LIMIT 1`, [chromeGroupId])[0]?.id ?? null;
}

function upsertTabGroup(group, winNodeId) {
  const existing = sqlQuery(`SELECT id FROM node WHERE node_type='group' AND chrome_id=? LIMIT 1`, [group.id])[0];
  const node = {
    node_type:    'group',
    chrome_id:    group.id,
    parent_id:    winNodeId,
    title:        group.title ?? '',
    color_active: group.color ?? null,
    is_collapsed: group.collapsed ? 1 : 0,
    is_open:      1,
    is_saved:     0,
  };
  if (existing) node.id = existing.id;
  return upsertNode(node);
}

export async function resync() {
  await ensureDb();
  const [wins, groups] = await Promise.all([
    chrome.windows.getAll({ populate: true }),
    chrome.tabGroups.query({}),
  ]);

  const currentWinIds   = new Set(wins.map(w => w.id));
  const currentGroupIds = new Set(groups.map(g => g.id));
  const currentTabIds   = new Set();
  for (const w of wins) for (const t of (w.tabs ?? [])) currentTabIds.add(t.id);

  // Sync windows
  for (const win of wins) {
    const existingWin = sqlQuery(`SELECT id FROM node WHERE chrome_id=? AND node_type='win' LIMIT 1`, [win.id])[0];
    const winNode = {
      node_type: 'win', is_open: 1, is_saved: 0, chrome_id: win.id,
      win_rect: `${win.left}_${win.top}_${win.width}_${win.height}`,
      relicons:  win.type ?? 'normal',
    };
    if (existingWin) winNode.id = existingWin.id;
    upsertNode(winNode);
  }

  // Sync tab groups (must come before tabs so group nodes exist for parent assignment)
  for (const group of groups) {
    const winNodeId = sqlQuery(`SELECT id FROM node WHERE node_type='win' AND chrome_id=? LIMIT 1`, [group.windowId])[0]?.id;
    if (winNodeId) upsertTabGroup(group, winNodeId);
  }

  // Sync tabs — always set parent_id so group membership stays accurate
  for (const win of wins) {
    const wid = sqlQuery(`SELECT id FROM node WHERE node_type='win' AND chrome_id=? LIMIT 1`, [win.id])[0]?.id;
    for (const tab of (win.tabs ?? [])) {
      const existingTab = sqlQuery(`SELECT id FROM node WHERE chrome_id=? AND node_type='tab' LIMIT 1`, [tab.id])[0];
      const parentId = (tab.groupId !== -1 ? tabGroupDbId(tab.groupId) : null) ?? wid;
      const tabNode = {
        node_type: 'tab', is_open: 1, is_saved: 0, chrome_id: tab.id,
        title: tab.title ?? '', url: tab.url ?? '', favicon_url: tab.favIconUrl ?? '',
        position: tab.index ?? 0,
        parent_id: parentId,
      };
      if (existingTab) tabNode.id = existingTab.id;
      upsertNode(tabNode);
    }
  }

  // Remove stale tabs
  const staleTabs = sqlQuery(`SELECT id, chrome_id FROM node WHERE node_type='tab' AND is_open=1 AND chrome_id IS NOT NULL`);
  for (const row of staleTabs) {
    if (!currentTabIds.has(row.chrome_id)) {
      sqlRun(`UPDATE node SET is_saved=1, is_open=0, chrome_id=NULL, updated_at=datetime('now') WHERE id=?`, [row.id]);
    }
  }

  // Remove stale tab groups — reparent their tabs to the win
  const staleGroups = sqlQuery(`SELECT id, parent_id FROM node WHERE node_type='group' AND is_open=1 AND chrome_id IS NOT NULL`);
  for (const row of staleGroups) {
    if (!currentGroupIds.has(row.chrome_id)) {
      sqlRun(`UPDATE node SET parent_id=? WHERE parent_id=?`, [row.parent_id, row.id]);
      sqlRun(`DELETE FROM node WHERE id=?`, [row.id]);
    }
  }

  // Remove stale windows
  const staleWins = sqlQuery(`SELECT id, chrome_id FROM node WHERE node_type='win' AND is_open=1 AND chrome_id IS NOT NULL`);
  for (const row of staleWins) {
    if (!currentWinIds.has(row.chrome_id)) {
      deleteOpenDescendants(row.id, null);
      if (hasSavedDescendants(row.id)) {
        sqlRun(`UPDATE node SET is_saved=1, is_open=0, chrome_id=NULL, updated_at=datetime('now') WHERE id=?`, [row.id]);
      } else {
        sqlRun('DELETE FROM node WHERE id=?', [row.id]);
      }
    }
  }

  await persistDb();
}

export async function initialize() {
  await resync();
  await updateBadge();
  console.log('TabSQL initialized');
}

function hasSavedDescendants(nodeId) {
  const children = sqlQuery('SELECT id, is_saved FROM node WHERE parent_id=?', [nodeId]);
  for (const child of children) {
    if (child.is_saved) return true;
    if (hasSavedDescendants(child.id)) return true;
  }
  return false;
}

function deleteOpenDescendants(nodeId, newParentId) {
  const children = sqlQuery('SELECT id, node_type, is_saved FROM node WHERE parent_id=?', [nodeId]);
  for (const child of children) {
    if (child.is_saved) {
      sqlRun(`UPDATE node SET parent_id=? WHERE id=?`, [newParentId, child.id]);
    } else if (child.node_type === 'tab') {
      deleteOpenDescendants(child.id, newParentId ?? nodeId);
      sqlRun('DELETE FROM node WHERE id=?', [child.id]);
    } else if (child.node_type === 'group') {
      deleteOpenDescendants(child.id, newParentId);
      sqlRun('DELETE FROM node WHERE id=?', [child.id]);
    }
  }
}

export async function updateBadge() {
  await ensureDb();
  const rows = sqlQuery(`SELECT COUNT(*) c FROM node WHERE node_type='tab' AND is_open=1`);
  const count = rows[0]?.c ?? 0;
  chrome.action.setBadgeBackgroundColor({ color: '#7c9ef8' });
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
}

async function onWindowCreated(win) { await upsertWin(win); await updateBadge(); }

async function onWindowRemoved(winId) {
  await ensureDb();
  const { popupWinId } = await chrome.storage.session.get('popupWinId');
  if (winId === popupWinId) {
    await chrome.storage.session.remove('popupWinId');
    return;
  }
  const winRow = sqlQuery(`SELECT id FROM node WHERE node_type='win' AND chrome_id=? LIMIT 1`, [winId])[0];
  if (!winRow) return;
  deleteOpenDescendants(winRow.id, null);
  if (hasSavedDescendants(winRow.id)) {
    sqlRun(`UPDATE node SET is_saved=1, is_open=0, chrome_id=NULL, updated_at=datetime('now') WHERE id=?`, [winRow.id]);
  } else {
    sqlRun('DELETE FROM node WHERE id=?', [winRow.id]);
  }
  await persistDb();
  await updateBadge();
}

async function onTabCreated(tab) {
  if (bgState.adoptedTabIds.has(tab.id)) {
    bgState.adoptedTabIds.delete(tab.id);
    return;
  }

  if (bgState.pendingAdopt && (Date.now() - bgState.pendingAdopt.ts < 5000)) {
    const { nodeId } = bgState.pendingAdopt;
    bgState.pendingAdopt = null;
    const savedPos = sqlQuery('SELECT position FROM node WHERE id=?', [nodeId])[0]?.position ?? -1;
    const pid = await winDbId(tab.windowId);
    upsertNode({
      id:          nodeId,
      chrome_id:   tab.id,
      is_open:     1,
      is_saved:    0,
      node_type:   'tab',
      parent_id:   pid,
      title:       tab.title      ?? '',
      url:         tab.url        ?? '',
      favicon_url: tab.favIconUrl ?? '',
      position:    tab.index      ?? 0,
    });
    await persistDb();
    if (savedPos >= 0 && savedPos !== tab.index) {
      try { await chrome.tabs.move(tab.id, { index: savedPos }); } catch {}
    }
    return;
  }

  let pid = null;
  if (tab.openerTabId) pid = await tabDbId(tab.openerTabId);
  if (pid == null && tab.groupId !== -1) pid = tabGroupDbId(tab.groupId);
  if (pid == null)     pid = await winDbId(tab.windowId);
  const newTabId = await upsertTab(tab, pid);
  const winId = await winDbId(tab.windowId);
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
    sqlRun(`UPDATE node SET parent_id=? WHERE parent_id=? AND node_type='tab' AND is_saved=1`, [row.parent_id, row.id]);
    sqlRun('DELETE FROM node WHERE id=?', [row.id]);
  }
  await persistDb();
  await updateBadge();
}

async function onTabMoved(tabId, moveInfo) {
  const id = await tabDbId(tabId);
  if (id == null) return;
  sqlRun(`UPDATE node SET position=?, updated_at=datetime('now') WHERE id=?`, [moveInfo.toIndex, id]);
  await persistDb();
}

async function onTabUpdated(tabId, changeInfo, tab) {
  await ensureDb();
  if (changeInfo.groupId !== undefined) {
    const id = await tabDbId(tabId);
    if (id != null) {
      const newParentId = changeInfo.groupId !== -1
        ? (tabGroupDbId(changeInfo.groupId) ?? await winDbId(tab.windowId))
        : await winDbId(tab.windowId);
      if (newParentId) sqlRun(`UPDATE node SET parent_id=?, updated_at=datetime('now') WHERE id=?`, [newParentId, id]);
      await persistDb();
    }
  }
  if (!changeInfo.url && !changeInfo.title && !changeInfo.favIconUrl) return;
  const id = await tabDbId(tabId);
  if (id == null) return;
  upsertNode({ id, title: tab.title ?? '', url: tab.url ?? '', favicon_url: tab.favIconUrl ?? '' });
  await persistDb();
}

async function onTabGroupCreated(group) {
  await ensureDb();
  const winNodeId = sqlQuery(`SELECT id FROM node WHERE node_type='win' AND chrome_id=? LIMIT 1`, [group.windowId])[0]?.id;
  if (!winNodeId) return;
  upsertTabGroup(group, winNodeId);
  await persistDb();
}

async function onTabGroupUpdated(group) {
  await ensureDb();
  const winNodeId = sqlQuery(`SELECT id FROM node WHERE node_type='win' AND chrome_id=? LIMIT 1`, [group.windowId])[0]?.id;
  if (!winNodeId) return;
  upsertTabGroup(group, winNodeId);
  await persistDb();
}

async function onTabGroupRemoved(group) {
  await ensureDb();
  const groupNode = sqlQuery(`SELECT id, parent_id FROM node WHERE node_type='group' AND chrome_id=? LIMIT 1`, [group.id])[0];
  if (!groupNode) return;
  sqlRun(`UPDATE node SET parent_id=? WHERE parent_id=?`, [groupNode.parent_id, groupNode.id]);
  sqlRun(`DELETE FROM node WHERE id=?`, [groupNode.id]);
  await persistDb();
}

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
