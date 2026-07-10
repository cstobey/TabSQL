import { parseSearchTerms } from './js/common.js';
import {
  ensureDb, persistDb, sqlQuery, sqlRun, sqlInsert, sqlExec, upsertNode,
  buildSearchWhere, DEFAULT_QUICK_QUERIES, bgState,
} from './js/bg-db.js';
import { executeActionRule } from './js/bg-rules.js';
import { initialize, resync } from './js/bg-sync.js';
import './js/bg-popup.js';

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

async function handleMessage(cmd, payload) {
  await ensureDb();
  switch (cmd) {
    case 'ping':
      return { ok: true };

    case 'get_tree': {
      const pid = payload?.parent_id ?? null;
      const rows = pid === null
        ? sqlQuery('SELECT * FROM node WHERE parent_id IS NULL ORDER BY position')
        : sqlQuery('SELECT * FROM node WHERE parent_id=? ORDER BY position', [pid]);
      return { ok: true, rows };
    }

    case 'upsert_node': {
      const id = upsertNode(payload.node);
      await persistDb();
      return { ok: true, id };
    }

    case 'delete_node': {
      const toDelete = [payload.id];
      const queue = [payload.id];
      while (queue.length) {
        const pid = queue.shift();
        const kids = sqlQuery('SELECT id FROM node WHERE parent_id=?', [pid]);
        kids.forEach(k => { toDelete.push(k.id); queue.push(k.id); });
      }
      toDelete.forEach(id => {
        sqlRun('DELETE FROM node_tag WHERE node_id=?', [id]);
        sqlRun('DELETE FROM win_auto_tag WHERE win_node_id=?', [id]);
        sqlRun('DELETE FROM node WHERE id=?', [id]);
      });
      await persistDb();
      return { ok: true };
    }

    case 'move_node':
      sqlRun(
        `UPDATE node SET parent_id=?, position=?, updated_at=datetime('now') WHERE id=?`,
        [payload.parent_id, payload.position, payload.id]
      );
      await persistDb();
      return { ok: true };

    case 'bulk_exec': {
      const sql = payload.sql;
      const rows = sqlQuery(sql);
      if (!/^\s*SELECT/i.test(sql)) await persistDb();
      return { ok: true, rows };
    }

    case 'search': {
      const terms = parseSearchTerms(payload.q.toLowerCase());
      const { where, params } = buildSearchWhere(terms);
      const rows = sqlQuery(`SELECT * FROM node WHERE ${where} LIMIT 200`, params);
      return { ok: true, rows };
    }

    case 'get_node': {
      const rows = sqlQuery('SELECT * FROM node WHERE id=?', [payload.id]);
      return { ok: true, row: rows[0] ?? null };
    }

    case 'import_nodes': {
      for (const node of payload.nodes) upsertNode(node);
      await persistDb();
      return { ok: true, count: payload.nodes.length };
    }

    case 'pre_open_tab':
      bgState.pendingAdopt = { nodeId: payload.nodeId, url: payload.url, ts: Date.now() };
      return { ok: true };

    case 'open_saved_window': {
      const savedTabs = sqlQuery(
        `SELECT id, url, position FROM node WHERE parent_id=? AND node_type='tab' AND is_saved=1 AND url IS NOT NULL ORDER BY position`,
        [payload.winNodeId]
      );
      if (!savedTabs.length) return { ok: true };
      const newWin = await chrome.windows.create({ url: savedTabs.map(t => t.url) });
      upsertNode({ id: payload.winNodeId, node_type: 'win', is_open: 1, is_saved: 0, chrome_id: newWin.id });
      const chromeTabs = newWin.tabs ?? [];
      for (let i = 0; i < Math.min(savedTabs.length, chromeTabs.length); i++) {
        upsertNode({ id: savedTabs[i].id, chrome_id: chromeTabs[i].id, is_open: 1, is_saved: 0, node_type: 'tab', position: i });
        bgState.adoptedTabIds.add(chromeTabs[i].id);
      }
      await persistDb();
      return { ok: true };
    }

    case 'save_window': {
      const openTabs = sqlQuery(
        `SELECT id, chrome_id FROM node WHERE parent_id=? AND node_type='tab' AND is_saved=0`,
        [payload.winNodeId]
      );
      for (const t of openTabs) {
        sqlRun(`UPDATE node SET is_saved=1, updated_at=datetime('now') WHERE id=?`, [t.id]);
      }
      await persistDb();
      const winRow = sqlQuery('SELECT chrome_id FROM node WHERE id=?', [payload.winNodeId])[0];
      if (winRow?.chrome_id) { try { await chrome.windows.remove(winRow.chrome_id); } catch {} }
      return { ok: true };
    }

    case 'get_quick_queries': {
      const rows = sqlQuery('SELECT * FROM quick_query ORDER BY position, label');
      return { ok: true, rows };
    }

    case 'save_quick_query': {
      const { id, label, sql } = payload;
      if (id) {
        sqlRun('UPDATE quick_query SET label=?, sql=? WHERE id=?', [label, sql, id]);
      } else {
        const maxPos = sqlQuery('SELECT MAX(position) m FROM quick_query')[0]?.m ?? -1;
        sqlInsert(
          'INSERT INTO quick_query (label, sql, position, is_default) VALUES (?,?,?,0)',
          [label, sql, maxPos + 1]
        );
      }
      await persistDb();
      return { ok: true };
    }

    case 'delete_quick_query':
      sqlRun('DELETE FROM quick_query WHERE id=?', [payload.id]);
      await persistDb();
      return { ok: true };

    case 'exec_raw': {
      sqlExec(payload.sql);
      await persistDb();
      return { ok: true };
    }

    case 'seed_default_queries': {
      const existing = new Set(
        sqlQuery('SELECT label FROM quick_query').map(r => r.label)
      );
      let added = 0;
      DEFAULT_QUICK_QUERIES.forEach((q, i) => {
        if (!existing.has(q.label)) {
          sqlInsert(
            'INSERT INTO quick_query (label, sql, position, is_default) VALUES (?,?,?,1)',
            [q.label, q.sql, i]
          );
          added++;
        }
      });
      await persistDb();
      return { ok: true, added };
    }

    // ── Tags ──────────────────────────────────────────────────────────────────
    case 'get_tags':
      return { ok: true, rows: sqlQuery('SELECT * FROM tag ORDER BY name') };

    case 'save_tag': {
      const { id: tid, name: tname, color: tcolor } = payload;
      if (tid) {
        sqlRun('UPDATE tag SET name=?, color=? WHERE id=?', [tname, tcolor, tid]);
        await persistDb();
        return { ok: true, id: tid };
      }
      const newId = sqlInsert('INSERT INTO tag (name, color) VALUES (?,?)', [tname, tcolor]);
      await persistDb();
      return { ok: true, id: newId };
    }

    case 'delete_tag': {
      sqlRun('DELETE FROM node_tag WHERE tag_id=?', [payload.id]);
      sqlRun('DELETE FROM win_auto_tag WHERE tag_id=?', [payload.id]);
      sqlRun('DELETE FROM tag WHERE id=?', [payload.id]);
      await persistDb();
      return { ok: true };
    }

    case 'get_node_tags': {
      const rows = sqlQuery(
        'SELECT t.* FROM tag t JOIN node_tag nt ON t.id=nt.tag_id WHERE nt.node_id=?',
        [payload.nodeId]
      );
      return { ok: true, rows };
    }

    case 'get_all_node_tags': {
      const rows = sqlQuery('SELECT nt.node_id, t.id, t.name, t.color FROM node_tag nt JOIN tag t ON t.id=nt.tag_id');
      return { ok: true, rows };
    }

    case 'set_node_tags': {
      sqlRun('DELETE FROM node_tag WHERE node_id=?', [payload.nodeId]);
      for (const tid of (payload.tagIds ?? [])) {
        sqlRun('INSERT OR IGNORE INTO node_tag (node_id, tag_id) VALUES (?,?)', [payload.nodeId, tid]);
      }
      await persistDb();
      return { ok: true };
    }

    case 'get_win_auto_tags': {
      const rows = sqlQuery(
        'SELECT t.* FROM tag t JOIN win_auto_tag wat ON t.id=wat.tag_id WHERE wat.win_node_id=?',
        [payload.winNodeId]
      );
      return { ok: true, rows };
    }

    case 'set_win_auto_tag': {
      if (payload.enabled) {
        sqlRun('INSERT OR IGNORE INTO win_auto_tag (win_node_id, tag_id) VALUES (?,?)', [payload.winNodeId, payload.tagId]);
      } else {
        sqlRun('DELETE FROM win_auto_tag WHERE win_node_id=? AND tag_id=?', [payload.winNodeId, payload.tagId]);
      }
      await persistDb();
      return { ok: true };
    }

    case 'tag_search_results': {
      const terms = parseSearchTerms((payload.q ?? '').toLowerCase());
      const { where, params } = buildSearchWhere(terms);
      const matched = sqlQuery(`SELECT id, node_type FROM node WHERE ${where} LIMIT 1000`, params);
      for (const n of matched) {
        sqlRun('INSERT OR IGNORE INTO node_tag (node_id, tag_id) VALUES (?,?)', [n.id, payload.tagId]);
        if (n.node_type === 'win') {
          sqlRun('INSERT OR IGNORE INTO win_auto_tag (win_node_id, tag_id) VALUES (?,?)', [n.id, payload.tagId]);
          const kids = sqlQuery('SELECT id FROM node WHERE parent_id=?', [n.id]);
          for (const k of kids) {
            sqlRun('INSERT OR IGNORE INTO node_tag (node_id, tag_id) VALUES (?,?)', [k.id, payload.tagId]);
          }
        }
      }
      await persistDb();
      return { ok: true, count: matched.length };
    }

    // ── Action rules ─────────────────────────────────────────────────────────
    case 'get_action_rules':
      return { ok: true, rows: sqlQuery('SELECT * FROM action_rule ORDER BY position, id') };

    case 'save_action_rule': {
      const { id: aid, name: aname, action_type, condition_type, condition, config, is_auto, position: apos } = payload;
      if (aid) {
        sqlRun(
          'UPDATE action_rule SET name=?, action_type=?, condition_type=?, condition=?, config=?, is_auto=? WHERE id=?',
          [aname, action_type, condition_type, condition, config ?? null, is_auto ? 1 : 0, aid]
        );
        await persistDb();
        return { ok: true, id: aid };
      }
      const maxPos = sqlQuery('SELECT MAX(position) m FROM action_rule')[0]?.m ?? -1;
      const newId = sqlInsert(
        'INSERT INTO action_rule (name, action_type, condition_type, condition, config, is_auto, position) VALUES (?,?,?,?,?,?,?)',
        [aname, action_type, condition_type, condition, config ?? null, is_auto ? 1 : 0, (apos ?? maxPos + 1)]
      );
      await persistDb();
      return { ok: true, id: newId };
    }

    case 'delete_action_rule':
      sqlRun('DELETE FROM action_rule WHERE id=?', [payload.id]);
      await persistDb();
      return { ok: true };

    case 'run_action_rule': {
      const rule = sqlQuery('SELECT * FROM action_rule WHERE id=?', [payload.id])[0];
      if (!rule) return { ok: false, error: 'Rule not found' };
      const affected = await executeActionRule(rule);
      return { ok: true, affected };
    }

    case 'run_auto_actions': {
      const rules = sqlQuery('SELECT * FROM action_rule WHERE is_auto=1');
      let total = 0;
      for (const rule of rules) total += await executeActionRule(rule);
      if (total > 0) await persistDb();
      return { ok: true, total };
    }

    case 'open_search_in_window': {
      const terms = parseSearchTerms((payload.q ?? '').toLowerCase());
      const { where, params } = buildSearchWhere(terms);
      const tabs = sqlQuery(
        `SELECT id, url, is_open, chrome_id, is_saved FROM node WHERE (${where}) AND node_type='tab' AND url IS NOT NULL AND id NOT IN (SELECT DISTINCT parent_id FROM node WHERE parent_id IS NOT NULL) LIMIT 50`,
        params
      );
      if (!tabs.length) return { ok: true, moved: 0 };

      const openTabs  = tabs.filter(t => t.is_open && t.chrome_id);
      const savedTabs = tabs.filter(t => !t.is_open || !t.chrome_id);

      let newWin;
      if (openTabs.length) {
        newWin = await chrome.windows.create({ tabId: openTabs[0].chrome_id });
        for (let i = 1; i < openTabs.length; i++) {
          await chrome.tabs.move(openTabs[i].chrome_id, { windowId: newWin.id, index: -1 });
        }
      } else {
        newWin = await chrome.windows.create({ url: savedTabs[0].url });
        bgState.adoptedTabIds.add(newWin.tabs[0].id);
      }

      let winNodeId = sqlQuery(`SELECT id FROM node WHERE chrome_id=? AND node_type='win' LIMIT 1`, [newWin.id])[0]?.id;
      if (!winNodeId) {
        winNodeId = upsertNode({
          node_type: 'win', is_open: 1, is_saved: 0, chrome_id: newWin.id,
          win_rect: `${newWin.left}_${newWin.top}_${newWin.width}_${newWin.height}`,
          relicons: newWin.type ?? 'normal',
        });
      }

      let pos = 0;
      for (const t of openTabs) {
        upsertNode({ id: t.id, parent_id: winNodeId, position: pos++ });
      }
      if (openTabs.length === 0 && savedTabs.length) {
        upsertNode({ id: savedTabs[0].id, chrome_id: newWin.tabs[0].id, is_open: 1, is_saved: 0, parent_id: winNodeId, position: pos++ });
        for (let i = 1; i < savedTabs.length; i++) {
          const newTab = await chrome.tabs.create({ windowId: newWin.id, url: savedTabs[i].url, active: false });
          bgState.adoptedTabIds.add(newTab.id);
          upsertNode({ id: savedTabs[i].id, chrome_id: newTab.id, is_open: 1, is_saved: 0, parent_id: winNodeId, position: pos++ });
        }
      } else {
        for (const t of savedTabs) {
          const newTab = await chrome.tabs.create({ windowId: newWin.id, url: t.url, active: false });
          bgState.adoptedTabIds.add(newTab.id);
          upsertNode({ id: t.id, chrome_id: newTab.id, is_open: 1, is_saved: 0, parent_id: winNodeId, position: pos++ });
        }
      }

      await persistDb();
      return { ok: true, moved: tabs.length };
    }

    case 'save_close_search': {
      const terms = parseSearchTerms((payload.q ?? '').toLowerCase());
      const { where, params } = buildSearchWhere(terms);
      const tabs = sqlQuery(
        `SELECT id, chrome_id, is_open FROM node WHERE (${where}) AND node_type='tab' AND url IS NOT NULL AND id NOT IN (SELECT DISTINCT parent_id FROM node WHERE parent_id IS NOT NULL) LIMIT 200`,
        params
      );
      let count = 0;
      for (const t of tabs) {
        sqlRun(`UPDATE node SET is_saved=1, is_open=0, chrome_id=NULL, updated_at=datetime('now') WHERE id=?`, [t.id]);
        if (t.is_open && t.chrome_id) { try { await chrome.tabs.remove(t.chrome_id); } catch {} }
        count++;
      }
      await persistDb();
      return { ok: true, count };
    }

    case 'close_search': {
      const terms = parseSearchTerms((payload.q ?? '').toLowerCase());
      const { where, params } = buildSearchWhere(terms);
      const tabs = sqlQuery(
        `SELECT id, chrome_id FROM node WHERE (${where}) AND node_type='tab' AND is_open=1 AND url IS NOT NULL AND id NOT IN (SELECT DISTINCT parent_id FROM node WHERE parent_id IS NOT NULL) LIMIT 200`,
        params
      );
      let count = 0;
      for (const t of tabs) {
        if (t.chrome_id) { try { await chrome.tabs.remove(t.chrome_id); } catch {} }
        count++;
      }
      return { ok: true, count };
    }

    // ── Config k/v ───────────────────────────────────────────────────────────
    case 'get_config': {
      const rows = payload.key
        ? sqlQuery('SELECT value FROM config WHERE key=?', [payload.key])
        : sqlQuery('SELECT key, value FROM config');
      if (payload.key) return { ok: true, value: rows[0]?.value ?? null };
      const obj = {};
      for (const r of rows) obj[r.key] = r.value;
      return { ok: true, values: obj };
    }

    case 'set_config': {
      if (payload.key !== undefined) {
        sqlRun('INSERT OR REPLACE INTO config (key, value) VALUES (?,?)', [payload.key, payload.value]);
      } else if (payload.entries) {
        for (const [k, v] of Object.entries(payload.entries)) {
          sqlRun('INSERT OR REPLACE INTO config (key, value) VALUES (?,?)', [k, v]);
        }
      }
      await persistDb();
      return { ok: true };
    }

    // ── Schema info ──────────────────────────────────────────────────────────
    case 'get_schema': {
      const tables = sqlQuery("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
      const views  = sqlQuery("SELECT name FROM sqlite_master WHERE type='view'  ORDER BY name");
      const result = {};
      for (const t of [...tables, ...views]) {
        try {
          result[t.name] = sqlQuery(`PRAGMA table_info(${t.name})`);
        } catch {}
      }
      return { ok: true, schema: result };
    }

    case 'resync':
      await resync();
      return { ok: true };

    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.to !== 'background') return;
  handleMessage(msg.cmd, msg.payload)
    .then(r  => sendResponse({ ok: true,  data: r }))
    .catch(e => sendResponse({ ok: false, error: e.message }));
  return true;
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

initialize().catch(e => console.error('TabSQL boot error:', e));
