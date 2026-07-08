import { state } from './state.js';
import { db } from './db-api.js';
import { escHtml, setStatus } from './helpers.js';
import { load, loadTags } from './render.js';

const tagPickerEl     = document.getElementById('tag-picker');
const tagPickerListEl = document.getElementById('tag-picker-list');

export async function openTagPicker(nodeId, x, y) {
  state.tagPickerNodeId = nodeId;
  const n = state.nodeMap[nodeId];
  const isWin = n?.node_type === 'win';

  const r = await db.send('get_node_tags', { nodeId });
  const currentTagIds = new Set((r?.rows ?? []).map(t => t.id));

  let autoTagIds = new Set();
  if (isWin) {
    const ar = await db.send('get_win_auto_tags', { winNodeId: nodeId });
    autoTagIds = new Set((ar?.rows ?? []).map(t => t.id));
  }

  renderTagPickerList(nodeId, currentTagIds, autoTagIds, isWin);

  tagPickerEl.style.left = Math.min(x, window.innerWidth - 220) + 'px';
  tagPickerEl.style.top  = Math.min(y, window.innerHeight - 300) + 'px';
  tagPickerEl.classList.remove('hidden');
}

export function renderTagPickerList(nodeId, currentTagIds, autoTagIds, isWin) {
  const treeEl = document.getElementById('tree');
  tagPickerListEl.innerHTML = state.allTags.map(t => `
    <div class="tag-pick-row" data-tag-id="${t.id}">
      <span class="tag-pick-dot" style="background:${escHtml(t.color)}"></span>
      <span class="tag-pick-name">${escHtml(t.name)}</span>
      <span class="tag-pick-check">${currentTagIds.has(t.id) ? '✓' : ''}</span>
    </div>
  `).join('') || '<div style="padding:4px 6px;font-size:11px;color:var(--muted)">No tags yet</div>';

  const autoSection = document.getElementById('tag-picker-win-auto');
  if (isWin) {
    autoSection.classList.remove('hidden');
  } else {
    autoSection.classList.add('hidden');
  }

  tagPickerListEl.querySelectorAll('.tag-pick-row').forEach(row => {
    row.addEventListener('click', async e => {
      e.stopPropagation();
      const tagId = +row.dataset.tagId;
      const wasOn = currentTagIds.has(tagId);
      if (wasOn) currentTagIds.delete(tagId); else currentTagIds.add(tagId);
      await db.send('set_node_tags', { nodeId: state.tagPickerNodeId, tagIds: [...currentTagIds] });
      state.nodeTagsMap[state.tagPickerNodeId] = state.allTags.filter(t => currentTagIds.has(t.id));
      const nodeEl = treeEl.querySelector(`[data-id="${state.tagPickerNodeId}"]`);
      if (nodeEl) {
        let chips = nodeEl.querySelector('.tag-chips');
        const tags = state.nodeTagsMap[state.tagPickerNodeId] ?? [];
        if (!chips) {
          chips = document.createElement('span');
          chips.className = 'tag-chips';
          const labelGroup = nodeEl.querySelector('.label-group');
          if (labelGroup) {
            labelGroup.appendChild(chips);
          } else {
            nodeEl.querySelector('.label').after(chips);
          }
        }
        chips.innerHTML = tags.map(t =>
          `<span class="tag-chip" style="background:${escHtml(t.color)}">${escHtml(t.name)}</span>`
        ).join('');
      }
      renderTagPickerList(state.tagPickerNodeId, currentTagIds, autoTagIds, isWin);
    });
  });

  if (isWin) {
    const cb = document.getElementById('tag-picker-auto-cb');
    cb.checked = [...currentTagIds].some(tid => autoTagIds.has(tid));
    cb.onchange = async () => {
      for (const tid of currentTagIds) {
        await db.send('set_win_auto_tag', { winNodeId: state.tagPickerNodeId, tagId: tid, enabled: cb.checked });
        if (cb.checked) autoTagIds.add(tid); else autoTagIds.delete(tid);
      }
    };
  }
}

// Add new tag from picker
document.getElementById('tag-picker-new-add').addEventListener('click', async e => {
  e.stopPropagation();
  const name  = document.getElementById('tag-picker-new-name').value.trim();
  const color = document.getElementById('tag-picker-new-color').value;
  if (!name) return;
  await db.send('save_tag', { name, color });
  await loadTags();
  document.getElementById('tag-picker-new-name').value = '';
  if (state.tagPickerNodeId != null) {
    const cr = await db.send('get_node_tags', { nodeId: state.tagPickerNodeId });
    const currentTagIds = new Set((cr?.rows ?? []).map(t => t.id));
    const n = state.nodeMap[state.tagPickerNodeId];
    const isWin = n?.node_type === 'win';
    renderTagPickerList(state.tagPickerNodeId, currentTagIds, new Set(), isWin);
  }
});

document.getElementById('tag-picker-new-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('tag-picker-new-add').click();
  e.stopPropagation();
});

// ── Search toolbar: tag results button ────────────────────────────────────────

document.getElementById('btn-tag-search').addEventListener('click', async e => {
  e.stopPropagation();
  if (!state.allTags.length) {
    setStatus('No tags defined yet — create one in Settings > Tags');
    return;
  }
  const q = document.getElementById('search').value.trim();
  const btn = document.getElementById('btn-tag-search');
  const rect = btn.getBoundingClientRect();
  state.tagPickerNodeId = null;

  const picker = document.getElementById('tag-picker');
  const autoSection = document.getElementById('tag-picker-win-auto');
  autoSection.classList.add('hidden');

  tagPickerListEl.innerHTML = state.allTags.map(t => `
    <div class="tag-pick-row" data-tag-id="${t.id}">
      <span class="tag-pick-dot" style="background:${escHtml(t.color)}"></span>
      <span class="tag-pick-name">${escHtml(t.name)}</span>
      <span class="tag-pick-check"></span>
    </div>
  `).join('');

  tagPickerListEl.querySelectorAll('.tag-pick-row').forEach(row => {
    row.addEventListener('click', async ev => {
      ev.stopPropagation();
      picker.classList.add('hidden');
      const tagId = +row.dataset.tagId;
      const r2 = await db.send('tag_search_results', { q, tagId });
      await load();
      setStatus(`Tagged ${r2?.count ?? 0} nodes`);
    });
  });

  picker.style.left = rect.left + 'px';
  picker.style.top  = (rect.bottom + 4) + 'px';
  picker.classList.remove('hidden');
});

// ── Config: Tags ──────────────────────────────────────────────────────────────

export async function loadCfgTags() {
  const r    = await db.send('get_tags');
  state.allTags    = r?.rows ?? [];
  const list = document.getElementById('cfg-tag-list');
  list.innerHTML = state.allTags.map(t => `
    <div class="tag-list-row">
      <span class="tag-list-dot" style="background:${escHtml(t.color)}"></span>
      <span class="tag-list-name">${escHtml(t.name)}</span>
      <button class="tag-list-del" data-id="${t.id}" title="Delete tag">✕</button>
    </div>
  `).join('') || '<div style="font-size:11px;color:var(--muted)">No tags yet</div>';

  list.querySelectorAll('.tag-list-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      await db.send('delete_tag', { id: +btn.dataset.id });
      await loadCfgTags();
      await load();
    });
  });
}

document.getElementById('cfg-tag-add').addEventListener('click', async () => {
  const name  = document.getElementById('cfg-tag-name').value.trim();
  const color = document.getElementById('cfg-tag-color').value;
  if (!name) return;
  await db.send('save_tag', { name, color });
  document.getElementById('cfg-tag-name').value = '';
  await loadCfgTags();
});

document.getElementById('cfg-tag-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('cfg-tag-add').click();
});
