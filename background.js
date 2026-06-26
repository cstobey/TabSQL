// background.js - MV3 service worker
// Bridges chrome.tabs/windows events <-> native messaging host

'use strict';

const HOST_NAME = 'com.taboutliner.host';
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
    console.warn('Tab Outliner+ host disconnected:', chrome.runtime.lastError?.message);
    port = null;
    // Retry after 5s
    setTimeout(connectHost, 5000);
  });
  console.log('Tab Outliner+ host connected');
}

function onHostMessage(msg) {
  const cb = pendingCallbacks[msg._id];
  if (cb) {
    delete pendingCallbacks[msg._id];
    cb(msg);
  }
}

function send(cmd, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!port) return reject(new Error('Host not connected'));
    const id = nextMsgId++;
    pendingCallbacks[id] = resolve;
    port.postMessage({ cmd, _id: id, ...payload });
  });
}

// -------------------------------------------------------------------------
// Chrome event handlers -> DB sync
// -------------------------------------------------------------------------

async function syncWindow(chromeWin) {
  const node = {
    node_type:  'win',
    is_open:    1,
    chrome_id:  chromeWin.id,
    win_rect:   `${chromeWin.left}_${chromeWin.top}_${chromeWin.width}_${chromeWin.height}`,
  };
  return send('upsert_node', { node });
}

async function syncTab(chromeTab) {
  const node = {
    node_type:  'tab',
    is_open:    1,
    chrome_id:  chromeTab.id,
    title:      chromeTab.title,
    url:        chromeTab.url,
    favicon_url: chromeTab.favIconUrl,
    position:   chromeTab.index,
  };
  return send('upsert_node', { node });
}

async function onWindowRemoved(windowId) {
  // Mark window as savedwin, tabs as savedtab
  await send('bulk_exec', {
    sql: `UPDATE node SET node_type='savedwin', is_open=0, chrome_id=NULL, updated_at=datetime('now')
          WHERE node_type='win' AND chrome_id=${windowId}`
  });
  await send('bulk_exec', {
    sql: `UPDATE node SET node_type='savedtab', is_open=0, updated_at=datetime('now')
          WHERE node_type='tab' AND parent_id IN (
            SELECT id FROM node WHERE node_type='savedwin' AND chrome_id IS NULL
          )`
  });
}

async function onTabRemoved(tabId, removeInfo) {
  if (removeInfo.isWindowClosing) return; // handled by onWindowRemoved
  await send('bulk_exec', {
    sql: `UPDATE node SET node_type='savedtab', is_open=0, chrome_id=NULL, updated_at=datetime('now')
          WHERE node_type='tab' AND chrome_id=${tabId}`
  });
}

async function onTabUpdated(tabId, changeInfo, tab) {
  if (!changeInfo.url && !changeInfo.title) return;
  await send('bulk_exec', {
    sql: `UPDATE node SET
            title=${JSON.stringify(tab.title)},
            url=${JSON.stringify(tab.url)},
            favicon_url=${JSON.stringify(tab.favIconUrl || '')},
            updated_at=datetime('now')
          WHERE node_type='tab' AND chrome_id=${tabId}`
  });
}

// -------------------------------------------------------------------------
// Message bridge for sidebar
// -------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.to !== 'background') return;
  send(msg.cmd, msg.payload)
    .then(r => sendResponse({ ok: true, data: r }))
    .catch(e => sendResponse({ ok: false, error: e.message }));
  return true; // async
});

// -------------------------------------------------------------------------
// Toolbar click -> open sidebar
// -------------------------------------------------------------------------

chrome.action.onClicked.addListener(() => {
  chrome.windows.create({
    url: chrome.runtime.getURL('sidebar/index.html'),
    type: 'popup',
    width: 400,
    height: 800,
  });
});

chrome.commands.onCommand.addListener(cmd => {
  if (cmd === 'open_sidebar') chrome.action.onClicked.dispatch();
});

// -------------------------------------------------------------------------
// Chrome event wiring
// -------------------------------------------------------------------------

chrome.windows.onRemoved.addListener(onWindowRemoved);
chrome.tabs.onRemoved.addListener(onTabRemoved);
chrome.tabs.onUpdated.addListener(onTabUpdated);

chrome.tabs.onCreated.addListener(tab => syncTab(tab));
chrome.windows.onCreated.addListener(win => syncWindow(win));

// -------------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------------

connectHost();
console.log('Tab Outliner+ background started');
