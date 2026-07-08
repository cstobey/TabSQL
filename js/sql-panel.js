import { db } from './db-api.js';
import { escHtml, setStatus } from './helpers.js';
import { load } from './render.js';

export const sqlQuickEl = document.getElementById('sql-quick');
let sqlLastRows  = [];

export async function loadQuickQueries() {
  const r    = await db.send('get_quick_queries');
  const rows = r?.rows ?? [];
  sqlQuickEl.innerHTML = '<option value="">Saved queries…</option>';
  rows.forEach(q => {
    const opt = document.createElement('option');
    opt.value        = q.id;
    opt.textContent  = q.label;
    opt.dataset.sql  = q.sql;
    opt.dataset.def  = q.is_default;
    sqlQuickEl.appendChild(opt);
  });
}

export async function runSQL(sql) {
  const statusEl  = document.getElementById('sql-status');
  const resultsEl = document.getElementById('sql-results');
  statusEl.textContent = 'Running…';
  const t0 = Date.now();
  try {
    const r    = await db.query(sql);
    const rows = r?.rows ?? [];
    const elapsed = Date.now() - t0;
    sqlLastRows = rows;
    renderSqlTable(rows);
    statusEl.textContent = `${rows.length} row${rows.length !== 1 ? 's' : ''} · ${elapsed}ms`;
    if (!/^\s*SELECT/i.test(sql)) load();
  } catch(e) {
    resultsEl.innerHTML = `<div style="color:var(--red);padding:8px;font-size:12px">Error: ${escHtml(e.message)}</div>`;
    statusEl.textContent = 'Error';
    sqlLastRows = [];
  }
}

function renderSqlTable(rows) {
  const el = document.getElementById('sql-results');
  if (!rows.length) {
    el.innerHTML = '<div style="padding:8px;color:var(--muted);font-size:12px">No rows returned.</div>';
    return;
  }
  const cols   = Object.keys(rows[0]);
  const header = `<tr>${cols.map(c => `<th>${escHtml(c)}</th>`).join('')}</tr>`;
  const body   = rows.map(row =>
    `<tr>${cols.map(c => {
      const v = row[c];
      return (v === null || v === undefined)
        ? `<td class="sql-null">NULL</td>`
        : `<td title="${escHtml(String(v))}">${escHtml(String(v))}</td>`;
    }).join('')}</tr>`
  ).join('');
  el.innerHTML = `<table><thead>${header}</thead><tbody>${body}</tbody></table>`;
}

// ── Quick-query select ────────────────────────────────────────────────────────

sqlQuickEl.addEventListener('change', () => {
  const opt = sqlQuickEl.options[sqlQuickEl.selectedIndex];
  if (!opt?.dataset.sql) return;
  document.getElementById('sql-input').value = opt.dataset.sql;
  runSQL(opt.dataset.sql);
});

// ── Save current query ────────────────────────────────────────────────────────

document.getElementById('sql-save-query').addEventListener('click', async () => {
  const sql = document.getElementById('sql-input').value.trim();
  if (!sql) return;

  const selOpt  = sqlQuickEl.options[sqlQuickEl.selectedIndex];
  const selId   = selOpt?.value ? +selOpt.value : null;
  const selLabel = selOpt?.textContent ?? '';

  let label, id;
  if (selId) {
    label = prompt(`Update "${selLabel}" or enter a new name to save a copy:`, selLabel);
    if (label === null) return;
    id = (label.trim() === selLabel) ? selId : null;
    label = label.trim() || selLabel;
  } else {
    label = prompt('Query name:', '');
    if (!label?.trim()) return;
    id = null;
  }

  await db.send('save_quick_query', { id, label: label.trim(), sql });
  await loadQuickQueries();
  for (const opt of sqlQuickEl.options) {
    if (opt.dataset.sql === sql && opt.textContent === label.trim()) {
      sqlQuickEl.value = opt.value;
      break;
    }
  }
  document.getElementById('sql-status').textContent = id ? 'Updated.' : 'Saved.';
});

// ── Delete selected query ─────────────────────────────────────────────────────

document.getElementById('sql-del-query').addEventListener('click', async () => {
  const id = +sqlQuickEl.value;
  if (!id) return;
  await db.send('delete_quick_query', { id });
  await loadQuickQueries();
  document.getElementById('sql-status').textContent = 'Deleted.';
});

// ── Restore defaults ──────────────────────────────────────────────────────────

document.getElementById('sql-restore-defaults').addEventListener('click', async () => {
  const r = await db.send('seed_default_queries');
  await loadQuickQueries();
  const added = r?.added ?? 0;
  document.getElementById('sql-status').textContent =
    added > 0 ? `${added} default${added > 1 ? 's' : ''} restored.` : 'All defaults already present.';
});

// ── Run / keyboard ────────────────────────────────────────────────────────────

document.getElementById('sql-run').addEventListener('click', () => {
  const sql = document.getElementById('sql-input').value.trim();
  if (sql) runSQL(sql);
});

document.getElementById('sql-input').addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') {
    const sql = e.target.value.trim();
    if (sql) runSQL(sql);
  }
});

// ── SQL panel resize ──────────────────────────────────────────────────────────

const sqlResizeEl = document.getElementById('sql-resize');
const sqlPanelEl  = document.getElementById('sql-panel');
const mainEl      = document.getElementById('main');
let resizing      = false;
let resizeStartY  = 0;
let resizeStartH  = 0;

sqlResizeEl.addEventListener('mousedown', e => {
  resizing     = true;
  resizeStartY = e.clientY;
  resizeStartH = sqlPanelEl.getBoundingClientRect().height;
  sqlResizeEl.classList.add('dragging');
  e.preventDefault();
});

document.addEventListener('mousemove', e => {
  if (!resizing) return;
  const delta = resizeStartY - e.clientY;
  const newH  = Math.max(60, Math.min(resizeStartH + delta, mainEl.clientHeight - 60));
  sqlPanelEl.style.height = newH + 'px';
});

document.addEventListener('mouseup', () => {
  if (!resizing) return;
  resizing = false;
  sqlResizeEl.classList.remove('dragging');
});

// ── Schema popup ──────────────────────────────────────────────────────────────

document.getElementById('sql-schema').addEventListener('click', async () => {
  const popup = document.getElementById('schema-popup');
  popup.classList.remove('hidden');
  const body = document.getElementById('schema-popup-body');
  body.innerHTML = '<div style="padding:16px;color:var(--muted)">Loading…</div>';
  try {
    const r = await db.send('get_schema');
    const schema = r?.schema ?? {};
    body.innerHTML = Object.entries(schema).map(([tname, cols]) => `
      <div class="schema-table">
        <div class="schema-table-name">${escHtml(tname)}</div>
        <table class="schema-cols">
          <thead><tr><th>col</th><th>type</th><th>notnull</th><th>default</th></tr></thead>
          <tbody>${(cols ?? []).map(c => `<tr>
            <td>${c.pk ? `<span class="schema-pk">PK </span>` : ''}${escHtml(c.name)}</td>
            <td>${escHtml(c.type)}</td>
            <td>${c.notnull ? '✓' : ''}</td>
            <td>${c.dflt_value != null ? escHtml(String(c.dflt_value)) : ''}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    `).join('');
  } catch(e) {
    body.innerHTML = `<div style="padding:16px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
});

document.getElementById('schema-popup-close').addEventListener('click', () => {
  document.getElementById('schema-popup').classList.add('hidden');
});
