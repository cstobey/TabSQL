import { state } from './state.js';
import { db } from './db-api.js';
import { escHtml } from './helpers.js';
import { load } from './render.js';

export async function loadCfgActions() {
  const [ar, tr] = await Promise.all([db.send('get_action_rules'), db.send('get_tags')]);
  state.allTags = tr?.rows ?? [];
  const rules = ar?.rows ?? [];
  const list  = document.getElementById('cfg-action-list');

  if (!rules.length) {
    list.innerHTML = '<div style="font-size:11px;color:var(--muted)">No actions yet</div>';
    return;
  }

  list.innerHTML = rules.map(r => {
    const cfg = r.config ? JSON.parse(r.config) : {};
    const tagName = cfg.tag_id ? (state.allTags.find(t => t.id === cfg.tag_id)?.name ?? '?') : '';
    const badgeText = r.action_type === 'add_tag'       ? `tag:${tagName}`
                    : r.action_type === 'delete'        ? `delete${cfg.delay_days ? ` (${cfg.delay_days}d)` : ''}`
                    : r.action_type === 'move'          ? 'move'
                    : r.action_type === 'save_on_close' ? 'save-on-close'
                    : r.action_type;
    return `
      <div class="action-row" data-rule-id="${r.id}">
        <div class="action-row-hdr">
          <span class="action-name">${escHtml(r.name)}</span>
          <span class="action-badges">
            <span class="action-badge">${escHtml(badgeText)}</span>
            ${r.is_auto ? '<span class="action-badge auto">auto</span>' : ''}
          </span>
          <span class="action-row-btns">
            <button class="ar-run" data-id="${r.id}" title="Run now">▶</button>
            <button class="ar-edit" data-id="${r.id}" title="Edit">✎</button>
            <button class="ar-del" data-id="${r.id}" title="Delete">✕</button>
          </span>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.ar-run').forEach(btn => {
    btn.addEventListener('click', async () => {
      const status = document.getElementById('cfg-actions-status');
      status.textContent = 'Running…';
      const r2 = await db.send('run_action_rule', { id: +btn.dataset.id });
      status.textContent = `${r2?.affected ?? 0} affected`;
      await load();
    });
  });

  list.querySelectorAll('.ar-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      await db.send('delete_action_rule', { id: +btn.dataset.id });
      await loadCfgActions();
    });
  });

  list.querySelectorAll('.ar-edit').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ruleId = +btn.dataset.id;
      const rule = rules.find(r => r.id === ruleId);
      if (!rule) return;
      showActionEditor(rule);
    });
  });
}

function showActionEditor(existing) {
  const list   = document.getElementById('cfg-action-list');
  const cfg    = existing?.config ? JSON.parse(existing.config) : {};
  const tagOpts = state.allTags.map(t => `<option value="${t.id}" ${cfg.tag_id === t.id ? 'selected' : ''}>${escHtml(t.name)}</option>`).join('');

  const editorHtml = `
    <div class="action-editor" id="action-editor-form">
      <div class="action-editor-row">
        <label>Name</label>
        <input type="text" id="ae-name" value="${escHtml(existing?.name ?? '')}" placeholder="Action name">
      </div>
      <div class="action-editor-row">
        <label>Type</label>
        <select id="ae-type">
          <option value="add_tag"       ${existing?.action_type === 'add_tag'       ? 'selected' : ''}>Add tag</option>
          <option value="delete"        ${existing?.action_type === 'delete'        ? 'selected' : ''}>Delete</option>
          <option value="move"          ${existing?.action_type === 'move'          ? 'selected' : ''}>Move to window</option>
          <option value="save_on_close" ${existing?.action_type === 'save_on_close' ? 'selected' : ''}>Save on close</option>
        </select>
      </div>
      <div class="action-editor-row" id="ae-tag-row">
        <label>Tag</label>
        <select id="ae-tag">${tagOpts}</select>
      </div>
      <div class="action-editor-row" id="ae-delay-row">
        <label>Delay (days, 0=immediate)</label>
        <input type="number" id="ae-delay" value="${cfg.delay_days ?? 0}" min="0">
      </div>
      <div class="action-editor-row" id="ae-win-row">
        <label>Target window node ID</label>
        <input type="number" id="ae-win" value="${cfg.target_win_id ?? ''}">
      </div>
      <div class="action-editor-row">
        <label>Condition type</label>
        <select id="ae-cond-type">
          <option value="search" ${existing?.condition_type !== 'sql' ? 'selected' : ''}>Search string</option>
          <option value="sql"    ${existing?.condition_type === 'sql'  ? 'selected' : ''}>SQL query</option>
        </select>
      </div>
      <div>
        <label>Condition</label>
        <textarea id="ae-condition" placeholder="Search terms or SQL SELECT…">${escHtml(existing?.condition ?? '')}</textarea>
      </div>
      <div class="action-editor-row">
        <label><input type="checkbox" id="ae-auto" ${existing?.is_auto ? 'checked' : ''}> Run automatically</label>
      </div>
      <div class="action-editor-row">
        <button class="btn" id="ae-save">Save</button>
        <button class="btn" id="ae-cancel">Cancel</button>
      </div>
    </div>`;

  const container = document.createElement('div');
  container.innerHTML = editorHtml;
  list.prepend(container);

  function updateVisibility() {
    const type = document.getElementById('ae-type').value;
    document.getElementById('ae-tag-row').style.display   = type === 'add_tag' ? '' : 'none';
    document.getElementById('ae-delay-row').style.display = type === 'delete'  ? '' : 'none';
    document.getElementById('ae-win-row').style.display   = type === 'move'    ? '' : 'none';
  }
  updateVisibility();
  document.getElementById('ae-type').addEventListener('change', updateVisibility);

  document.getElementById('ae-cancel').addEventListener('click', () => {
    container.remove();
  });

  document.getElementById('ae-save').addEventListener('click', async () => {
    const name      = document.getElementById('ae-name').value.trim();
    const type      = document.getElementById('ae-type').value;
    const condType  = document.getElementById('ae-cond-type').value;
    const condition = document.getElementById('ae-condition').value.trim();
    const isAuto    = document.getElementById('ae-auto').checked;
    if (!name || !condition) return;
    const cfgObj = {};
    if (type === 'add_tag') cfgObj.tag_id = +document.getElementById('ae-tag').value;
    if (type === 'delete')  cfgObj.delay_days = +document.getElementById('ae-delay').value;
    if (type === 'move')    cfgObj.target_win_id = +document.getElementById('ae-win').value;
    await db.send('save_action_rule', {
      id: existing?.id,
      name, action_type: type, condition_type: condType, condition,
      config: JSON.stringify(cfgObj), is_auto: isAuto,
    });
    container.remove();
    await loadCfgActions();
  });
}

document.getElementById('cfg-action-new').addEventListener('click', () => showActionEditor(null));

document.getElementById('cfg-action-run-all').addEventListener('click', async () => {
  const status = document.getElementById('cfg-actions-status');
  status.textContent = 'Running…';
  const r = await db.send('run_auto_actions');
  status.textContent = `${r?.total ?? 0} affected`;
  await load();
});
