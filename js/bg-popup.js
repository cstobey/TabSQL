import { ensureDb, persistDb, sqlQuery, sqlRun } from './bg-db.js';

async function openOrFocusPopup() {
  const { popupWinId } = await chrome.storage.session.get('popupWinId');
  if (popupWinId != null) {
    try {
      await chrome.windows.update(popupWinId, { focused: true });
      return;
    } catch {}
  }
  await ensureDb();
  const cfg = {};
  for (const r of sqlQuery("SELECT key, value FROM config WHERE key IN ('popup_width','popup_height','popup_left','popup_top')")) {
    cfg[r.key] = +r.value;
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('index.html'),
    type: 'popup',
    width:  cfg.popup_width  ?? 400,
    height: cfg.popup_height ?? 800,
    ...(cfg.popup_left != null ? { left: cfg.popup_left } : {}),
    ...(cfg.popup_top  != null ? { top:  cfg.popup_top  } : {}),
  });
  await chrome.storage.session.set({ popupWinId: win.id });
}

chrome.windows.onBoundsChanged.addListener(async win => {
  const { popupWinId } = await chrome.storage.session.get('popupWinId');
  if (win.id !== popupWinId) return;
  await ensureDb();
  for (const [k, v] of [['popup_width', win.width], ['popup_height', win.height], ['popup_left', win.left], ['popup_top', win.top]]) {
    sqlRun('INSERT OR REPLACE INTO config (key, value) VALUES (?,?)', [k, String(v)]);
  }
  await persistDb();
});

chrome.action.onClicked.addListener(() => {
  openOrFocusPopup().catch(e => console.error('openPopup:', e));
});

chrome.commands.onCommand.addListener(cmd => {
  if (cmd === 'open_sidebar') openOrFocusPopup().catch(console.error);
});

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason !== 'update') return;
  chrome.storage.session.get('popupWinId').then(async ({ popupWinId }) => {
    if (popupWinId == null) return;
    try { await chrome.windows.remove(popupWinId); } catch {}
    await chrome.storage.session.remove('popupWinId');
    await openOrFocusPopup();
  }).catch(console.error);
});
