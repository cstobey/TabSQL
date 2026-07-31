import { state } from './state.js';

export async function syncFocusState() {
  const wins = await chrome.windows.getAll({ populate: true }).catch(() => []);
  state.focusState.activeTabChromeIds = new Set();
  state.focusState.focusedWinChromeId = null;
  for (const w of wins) {
    if (w.focused) state.focusState.focusedWinChromeId = w.id;
    for (const t of (w.tabs ?? [])) {
      if (t.active) state.focusState.activeTabChromeIds.add(t.id);
    }
  }
}

export function applyFocusHighlights() {
  const treeEl = document.getElementById('tree');
  treeEl.querySelectorAll('.focus-active').forEach(el => el.classList.remove('focus-active'));
  for (const chromeId of state.focusState.activeTabChromeIds) {
    const node = state.allNodes.find(n => n.chrome_id === chromeId);
    if (node) treeEl.querySelector(`[data-id="${node.id}"]`)?.classList.add('focus-active');
  }
  if (state.focusState.focusedWinChromeId) {
    const winNode = state.allNodes.find(n => n.node_type === 'win' && n.is_open && n.chrome_id === state.focusState.focusedWinChromeId);
    if (winNode) treeEl.querySelector(`[data-id="${winNode.id}"]`)?.classList.add('focus-active');
  }
}
