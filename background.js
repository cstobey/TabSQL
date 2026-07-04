// background.js - MV3 service worker
'use strict';

const HOST_NAME = 'com.tabsql.host';
let port = null;
let pendingCallbacks = {};
let nextMsgId = 1;

// -------------------------------------------------------------------------
// Native messaging
// -------------------------------------------------------------------------

function connectHost() {
  port = chrome.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    console.warn('TabSQL host disconnected:', chrome.runtime.lastError?.message);
    port = null;
    setTimeout(connectHost, 5000);
  });
  console.log('TabSQL host connected');
  initialize().catch(e => console.error('TabSQL init error:', e));
}

function onHostMessage(msg) {
  const cb = pendingCallbacks[msg._id];
  if (cb) { delete pendingCallbacks[msg._id]; cb(msg); }
}

function send(cmd, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!port) return reject(new Error('Host not connected'));
    const id = nextMsgId++;
    pendingCallbacks[id] = resolve;
    port.postMessage({ cmd, _id: id, ...payload });
  });
}

async function sqlQuery(sql) {
  const r = await send('bulk_exec', { sql });
  return r?.rows ?? [];
}

// -------------------------------------------------------------------------
// Startup sync — pull all currently open windows + tabs into DB
// -------------------------------------------------------------------------

async function initialize() {
  const wins = await chrome.windows.getAll({ populate: true });
  for (const win of wins) {
    const winDbId = await upsertWin(win);
    for (const tab of (win.tabs ?? [])) {
      await upsertTab(tab, winDbId);
    }
  }
  console.log('TabSQL initialized');
}

// -------------------------------------------------------------------------
// Node helpers
// -------------------------------------------------------------------------

async function upsertWin(chromeWin) {
  const node = {
    node_type: 'win',
    is_open:   1,
    chrome_id: chromeWin.id,
    win_rect:  `${chromeWin.left}_${chromeWin.top}_${chromeWin.width}_${chromeWin.height}`,
  };
  const r = await send('upsert_node', { node });
  return r?.id ?? null;
}

async function upsertTab(chromeTab, parentDbId) {
  const node = {
    node_type:   'tab',
    is_open:     1,
    chrome_id:   chromeTab.id,
    title:       chromeTab.title       ?? '',
    url:         chromeTab.url         ?? '',
    favicon_url: chromeTab.favIconUrl  ?? '',
    position:    chromeTab.index       ?? 0,
  };
  if (parentDbId != null) node.parent_id = parentDbId;
  return send('upsert_node', { node });
}

// Return the DB id of the window row for a given Chrome window id
async function winDbIdFor(chromeWinId) {
  const rows = await sqlQuery(
    `SELECT id FROM node WHERE node_type IN ('win','savedwin') AND chrome_id=${chromeWinId} LIMIT 1`
  );
  return rows[0]?.id ?? null;
}

// Return the DB id of the tab row for a given Chrome tab id
async function tabDbIdFor(chromeTabId) {
  const rows = await sqlQuery(
    `SELECT id FROM node WHERE node_type IN ('tab','savedtab') AND chrome_id=${chromeTabId} LIMIT 1`
  );
  return rows[0]?.id ?? null;
}

// -------------------------------------------------------------------------
// Chrome event handlers
// -------------------------------------------------------------------------

async function onWindowCreated(chromeWin) {
  await upsertWin(chromeWin);
}

async function onWindowRemoved(chromeWinId) {
  // Mark the window's tabs FIRST (while we can still identify the window by chrome_id).
  await sqlQuery(
    `UPDATE node SET node_type='savedtab', is_open=0, updated_at=datetime('now')
     WHERE node_type='tab' AND parent_id=(
       SELECT id FROM node WHERE node_type='win' AND chrome_id=${chromeWinId} LIMIT 1
     )`
  );
  await sqlQuery(
    `UPDATE node SET node_type='savedwin', is_open=0, chrome_id=NULL, updated_at=datetime('now')
     WHERE node_type='win' AND chrome_id=${chromeWinId}`
  );
}

async function onTabCreated(chromeTab) {
  const parentDbId = await winDbIdFor(chromeTab.windowId);
  await upsertTab(chromeTab, parentDbId);
}

async function onTabRemoved(tabId, removeInfo) {
  if (removeInfo.isWindowClosing) return; // onWindowRemoved handles this
  await sqlQuery(
    `UPDATE node SET node_type='savedtab', is_open=0, chrome_id=NULL, updated_at=datetime('now')
     WHERE node_type='tab' AND chrome_id=${tabId}`
  );
}

async function onTabUpdated(tabId, changeInfo, tab) {
  if (!changeInfo.url && !changeInfo.title && !changeInfo.favIconUrl) return;
  const dbId = await tabDbIdFor(tabId);
  if (dbId == null) return;
  // Use upsert_node so values are parameterized in Python (no injection risk)
  await send('upsert_node', {
    node: {
      id:          dbId,
      title:       tab.title      ?? '',
      url:         tab.url        ?? '',
      favicon_url: tab.favIconUrl ?? '',
    },
  });
}

// -------------------------------------------------------------------------
// Event wiring (wrap async handlers so rejections surface in console)
// -------------------------------------------------------------------------

function guard(fn) {
  return (...args) => fn(...args).catch(e => console.error(fn.name + ':', e));
}

chrome.windows.onCreated.addListener(guard(onWindowCreated));
chrome.windows.onRemoved.addListener(guard(onWindowRemoved));
chrome.tabs.onCreated.addListener(guard(onTabCreated));
chrome.tabs.onRemoved.addListener(guard(onTabRemoved));
chrome.tabs.onUpdated.addListener(guard(onTabUpdated));

// -------------------------------------------------------------------------
// Message bridge for sidebar / management UI
// -------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.to !== 'background') return;
  send(msg.cmd, msg.payload)
    .then(r => sendResponse({ ok: true, data: r }))
    .catch(e => sendResponse({ ok: false, error: e.message }));
  return true;
});

// -------------------------------------------------------------------------
// Toolbar click -> open sidebar
// -------------------------------------------------------------------------

chrome.action.onClicked.addListener(() => {
  chrome.windows.create({
    url: chrome.runtime.getURL('index.html'),
    type: 'popup',
    width: 400,
    height: 800,
  });
});

chrome.commands.onCommand.addListener(cmd => {
  if (cmd === 'open_sidebar') chrome.action.onClicked.dispatch();
});

// -------------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------------

connectHost();
console.log('TabSQL background started');
