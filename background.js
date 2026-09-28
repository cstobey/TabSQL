import {
  ensureDb, persistDb, sqlQuery, sqlRun, sqlInsert, sqlExec,
  extractDomain, buildSearchWhere, DEFAULT_QUICK_QUERIES, bgState,
  getWinChromeId, getRecursiveOpenChildren, renumberOrderBy, rowsModified, NEXT_ROOT_ORDER,
} from './js/bg-db.js';
import { executeActionRule, chromeMoveIntoWin } from './js/bg-rules.js';
import { initialize, resync, dedupeWindows, cascadeChildrenToChrome } from './js/bg-sync.js';
import './js/bg-popup.js';

const LEAF_TABS = `node_type='tab' AND url != '' AND id NOT IN (SELECT DISTINCT parent_id FROM node WHERE parent_id IS NOT NULL)`;

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

async function handleMessage(cmd, payload) {
  await ensureDb();
  switch (cmd) {
    case 'upsert_node': {
      const node = { ...payload.node };
      if ('url' in node && !('domain' in node)) node.domain = extractDomain(node.url);
      let id;
      if ('id' in node) {
        const cols = Object.keys(node).filter(k => k !== 'id');
        sqlRun(
          `UPDATE node SET ${cols.map(c => `${c}=?`).join(', ')} WHERE id=?`,
          [...cols.map(c => node[c] ?? null), node.id]
        );
        id = node.id;
      } else {
        const cols = Object.keys(node);
        id = sqlInsert(
          `INSERT INTO node (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          cols.map(c => node[c] ?? null)
        );
      }
      await persistDb();
      return { ok: true, id };
    }

    case 'delete_node': {
      const id = Math.trunc(+payload.id);
      sqlExec(`
        DROP TABLE IF EXISTS tmp_doomed;
        CREATE TEMP TABLE tmp_doomed AS
          WITH RECURSIVE d(id) AS (
            SELECT ${id} UNION ALL SELECT n.id FROM node n JOIN d ON n.parent_id = d.id
          ) SELECT id FROM d;
        DELETE FROM node_tag     WHERE node_id     IN (SELECT id FROM tmp_doomed);
        DELETE FROM win_auto_tag WHERE win_node_id IN (SELECT id FROM tmp_doomed);
        DELETE FROM node         WHERE id          IN (SELECT id FROM tmp_doomed);
        DROP TABLE tmp_doomed;
      `);
      await persistDb();
      return { ok: true };
    }

    // TabSQL-initiated move: the whole subtree follows in Chrome (cascade). The node
    // slots in just before the sibling holding the requested order_by; renumber packs
    // the fractional slot back to integers on both affected parents. updated_at is set
    // explicitly because node_touch ignores same-parent order_by-only changes.
    case 'move_node': {
      const { id: mnId, order_by: mnOb } = payload;
      const mnPid = payload.parent_id ?? null;
      const oldPid = sqlQuery(`SELECT parent_id FROM node WHERE id=?`, [mnId])[0]?.parent_id;
      sqlRun(
        `UPDATE node SET parent_id=?, order_by=? - 0.5, updated_at=datetime('now') WHERE id=?`,
        [mnPid, mnOb, mnId]
      );
      renumberOrderBy([mnPid, oldPid]);
      const mnRow = sqlQuery(`SELECT chrome_id, is_open FROM node WHERE id=?`, [mnId])[0];
      if (mnRow?.is_open && mnRow?.chrome_id) {
        const winChromeId = getWinChromeId(mnPid);
        if (winChromeId) {
          const pred = sqlQuery(
            `SELECT position FROM node
             WHERE parent_id=? AND is_open=1 AND chrome_id IS NOT NULL AND id!=?
               AND order_by < (SELECT order_by FROM node WHERE id=?)
             ORDER BY order_by DESC LIMIT 1`,
            [mnPid, mnId, mnId]
          )[0];
          const parent = sqlQuery(`SELECT node_type, position FROM node WHERE id=?`, [mnPid])[0];
          const targetIdx = pred ? pred.position + 1
                          : parent?.node_type === 'win' ? 0
                          : (parent?.position ?? 0) + 1;
          bgState.movingTabIds.set(mnRow.chrome_id, Date.now());
          try {
            await chrome.tabs.move(mnRow.chrome_id, { windowId: winChromeId, index: targetIdx });
            await cascadeChildrenToChrome(mnId, targetIdx + 1, winChromeId);
          } catch {}
        }
      }
      await persistDb();
      return { ok: true };
    }

    case 'bulk_exec': {
      const sql = payload.sql;
      const rows = sqlQuery(sql);
      if (!/^\s*SELECT/i.test(sql)) await persistDb();
      return { ok: true, rows };
    }

    case 'search': {
      const { where, params } = buildSearchWhere(payload.q);
      const rows = sqlQuery(
        `WITH RECURSIVE visible(id, is_matched) AS (
           SELECT id, 1 FROM node WHERE ${where}
           UNION
           SELECT n.parent_id, 0 FROM node n JOIN visible v ON n.id = v.id WHERE n.parent_id IS NOT NULL
         )
         SELECT id, MAX(is_matched) AS is_matched FROM visible GROUP BY id`,
        params
      );
      const matchedCount = rows.filter(r => r.is_matched).length;
      return { ok: true, matchedCount, visibleIds: rows.map(r => r.id) };
    }

    case 'pre_open_tab':
      bgState.pendingAdopt = { nodeId: payload.nodeId, url: payload.url, ts: Date.now() };
      return { ok: true };

    // Reopens every saved descendant tab (DFS tree order) in a new window and grafts
    // the new chrome ids onto the existing nodes. pendingWinAdopt stops onWindowCreated
    // from inserting a duplicate win node; the conflict-clearing UPDATE undoes any
    // silent per-tab adoption that raced us. is_saved stays 1 throughout (sticky).
    case 'open_saved_window': {
      const wid = Math.trunc(+payload.winNodeId);
      const savedTabs = sqlQuery(`
        WITH RECURSIVE d(id, url, is_open, is_saved, node_type, path) AS (
          SELECT id, url, is_open, is_saved, node_type, printf('%08d', order_by) FROM node WHERE parent_id=?
          UNION ALL
          SELECT n.id, n.url, n.is_open, n.is_saved, n.node_type, d.path || '/' || printf('%08d', n.order_by)
          FROM node n JOIN d ON n.parent_id = d.id
        )
        SELECT id, url FROM d WHERE node_type='tab' AND is_saved=1 AND is_open=0 AND url != '' ORDER BY path
      `, [wid]);
      if (!savedTabs.length) return { ok: true };
      bgState.pendingWinAdopt = { nodeId: wid, ts: Date.now() };
      const newWin = await chrome.windows.create({ url: savedTabs.map(t => t.url) });
      const chromeTabs = newWin.tabs ?? [];
      chromeTabs.forEach(t => bgState.adoptedTabIds.add(t.id));
      const n = Math.min(savedTabs.length, chromeTabs.length);
      if (n) {
        sqlExec(`DROP TABLE IF EXISTS tmp_open; CREATE TEMP TABLE tmp_open (node_id INTEGER PRIMARY KEY, chrome_id INTEGER, pos INTEGER);`);
        sqlRun(
          `INSERT INTO tmp_open VALUES ${Array.from({ length: n }, () => '(?,?,?)').join(',')}`,
          Array.from({ length: n }).flatMap((_, i) => [savedTabs[i].id, chromeTabs[i].id, i])
        );
        sqlExec(`
          UPDATE node SET chrome_id=NULL, is_open=0
            WHERE node_type='tab' AND chrome_id IN (SELECT chrome_id FROM tmp_open)
              AND id NOT IN (SELECT node_id FROM tmp_open);
          UPDATE node SET
              chrome_id = (SELECT chrome_id FROM tmp_open o WHERE o.node_id = node.id),
              position  = (SELECT pos       FROM tmp_open o WHERE o.node_id = node.id),
              is_open=1
            WHERE id IN (SELECT node_id FROM tmp_open);
          DROP TABLE tmp_open;
        `);
      }
      sqlRun(`UPDATE node SET is_open=1, chrome_id=? WHERE id=?`, [newWin.id, wid]);
      await persistDb();
      return { ok: true };
    }

    case 'save_window': {
      const wid = Math.trunc(+payload.winNodeId);
      sqlExec(`
        UPDATE node SET is_saved=1
        WHERE is_saved=0
          AND (id=${wid} OR id IN (SELECT id FROM node_tree WHERE win_node_id=${wid} AND node_type='tab'));
      `);
      await persistDb();
      const winRow = sqlQuery(`SELECT chrome_id FROM node WHERE id=? AND is_open=1`, [wid])[0];
      if (winRow?.chrome_id) { try { await chrome.windows.remove(winRow.chrome_id); } catch {} }
      return { ok: true };
    }

    case 'set_tab_pinned': {
      const { nodeId, pinned } = payload;
      const row = sqlQuery(`SELECT chrome_id FROM node WHERE id=?`, [nodeId])[0];
      if (row?.chrome_id) {
        await chrome.tabs.update(row.chrome_id, { pinned });
      }
      sqlRun(`UPDATE node SET is_pinned=? WHERE id=?`, [pinned ? 1 : 0, nodeId]);
      await persistDb();
      return { ok: true };
    }

    case 'get_quick_queries':
      return { ok: true, rows: sqlQuery(`SELECT * FROM quick_query ORDER BY position, label`) };

    case 'save_quick_query': {
      const { id, label, sql } = payload;
      if (id) {
        sqlRun(`UPDATE quick_query SET label=?, sql=? WHERE id=?`, [label, sql, id]);
      } else {
        sqlRun(
          `INSERT INTO quick_query (label, sql, position, is_default)
           VALUES (?,?,(SELECT COALESCE(MAX(position),-1)+1 FROM quick_query),0)`,
          [label, sql]
        );
      }
      await persistDb();
      return { ok: true };
    }

    case 'delete_quick_query':
      sqlRun(`DELETE FROM quick_query WHERE id=?`, [payload.id]);
      await persistDb();
      return { ok: true };

    case 'exec_raw': {
      sqlExec(payload.sql);
      await persistDb();
      return { ok: true };
    }

    case 'seed_default_queries': {
      sqlRun(
        `INSERT INTO quick_query (label, sql, position, is_default)
         SELECT column1, column2, column3, 1 FROM (VALUES ${DEFAULT_QUICK_QUERIES.map(() => '(?,?,?)').join(',')})
         WHERE column1 NOT IN (SELECT label FROM quick_query)`,
        DEFAULT_QUICK_QUERIES.flatMap((q, i) => [q.label, q.sql, i])
      );
      const added = rowsModified();
      await persistDb();
      return { ok: true, added };
    }

    // ── Tags ──────────────────────────────────────────────────────────────────
    case 'get_tags':
      return { ok: true, rows: sqlQuery(`SELECT * FROM tag ORDER BY name`) };

    case 'save_tag': {
      const { id: tid, name: tname, color: tcolor } = payload;
      const newId = tid
        ? (sqlRun(`UPDATE tag SET name=?, color=? WHERE id=?`, [tname, tcolor, tid]), tid)
        : sqlInsert(`INSERT INTO tag (name, color) VALUES (?,?)`, [tname, tcolor]);
      await persistDb();
      return { ok: true, id: newId };
    }

    case 'delete_tag': {
      const tid = Math.trunc(+payload.id);
      sqlExec(`
        DELETE FROM node_tag     WHERE tag_id=${tid};
        DELETE FROM win_auto_tag WHERE tag_id=${tid};
        DELETE FROM tag          WHERE id=${tid};
      `);
      await persistDb();
      return { ok: true };
    }

    case 'get_node_tags':
      return {
        ok: true,
        rows: sqlQuery(`SELECT t.* FROM tag t JOIN node_tag nt ON t.id=nt.tag_id WHERE nt.node_id=?`, [payload.nodeId]),
      };

    case 'get_all_node_tags':
      return {
        ok: true,
        rows: sqlQuery(`SELECT nt.node_id, t.id, t.name, t.color FROM node_tag nt JOIN tag t ON t.id=nt.tag_id`),
      };

    case 'set_node_tags': {
      sqlRun(`DELETE FROM node_tag WHERE node_id=?`, [payload.nodeId]);
      const tids = (payload.tagIds ?? []).map(Number).filter(Number.isFinite);
      if (tids.length) {
        sqlRun(
          `INSERT OR IGNORE INTO node_tag (node_id, tag_id) VALUES ${tids.map(() => '(?,?)').join(',')}`,
          tids.flatMap(t => [payload.nodeId, t])
        );
      }
      await persistDb();
      return { ok: true };
    }

    case 'get_win_auto_tags':
      return {
        ok: true,
        rows: sqlQuery(`SELECT t.* FROM tag t JOIN win_auto_tag wat ON t.id=wat.tag_id WHERE wat.win_node_id=?`, [payload.winNodeId]),
      };

    case 'set_win_auto_tag': {
      if (payload.enabled) {
        sqlRun(`INSERT OR IGNORE INTO win_auto_tag (win_node_id, tag_id) VALUES (?,?)`, [payload.winNodeId, payload.tagId]);
      } else {
        sqlRun(`DELETE FROM win_auto_tag WHERE win_node_id=? AND tag_id=?`, [payload.winNodeId, payload.tagId]);
      }
      await persistDb();
      return { ok: true };
    }

    case 'tag_search_results': {
      const { where, params } = buildSearchWhere(payload.q);
      const tagId = Math.trunc(+payload.tagId);
      sqlExec(`DROP TABLE IF EXISTS tmp_m; CREATE TEMP TABLE tmp_m (id INTEGER PRIMARY KEY, node_type TEXT);`);
      sqlRun(`INSERT INTO tmp_m SELECT id, node_type FROM node WHERE ${where} LIMIT 1000`, params);
      sqlExec(`
        INSERT OR IGNORE INTO node_tag (node_id, tag_id) SELECT id, ${tagId} FROM tmp_m;
        INSERT OR IGNORE INTO win_auto_tag (win_node_id, tag_id) SELECT id, ${tagId} FROM tmp_m WHERE node_type='win';
        INSERT OR IGNORE INTO node_tag (node_id, tag_id)
          SELECT n.id, ${tagId} FROM node n WHERE n.parent_id IN (SELECT id FROM tmp_m WHERE node_type='win');
      `);
      const count = sqlQuery(`SELECT COUNT(*) c FROM tmp_m`)[0].c;
      sqlExec(`DROP TABLE tmp_m`);
      await persistDb();
      return { ok: true, count };
    }

    // ── Action rules ─────────────────────────────────────────────────────────
    case 'get_action_rules':
      return { ok: true, rows: sqlQuery(`SELECT * FROM action_rule ORDER BY position, id`) };

    case 'save_action_rule': {
      const { id: aid, name: aname, action_type, condition_type, condition, config, is_auto, position: apos } = payload;
      if (aid) {
        sqlRun(
          `UPDATE action_rule SET name=?, action_type=?, condition_type=?, condition=?, config=?, is_auto=? WHERE id=?`,
          [aname, action_type, condition_type, condition, config ?? null, is_auto ? 1 : 0, aid]
        );
        await persistDb();
        return { ok: true, id: aid };
      }
      const newId = sqlInsert(
        `INSERT INTO action_rule (name, action_type, condition_type, condition, config, is_auto, position)
         VALUES (?,?,?,?,?,?,COALESCE(?,(SELECT COALESCE(MAX(position),-1)+1 FROM action_rule)))`,
        [aname, action_type, condition_type, condition, config ?? null, is_auto ? 1 : 0, apos ?? null]
      );
      await persistDb();
      return { ok: true, id: newId };
    }

    case 'delete_action_rule':
      sqlRun(`DELETE FROM action_rule WHERE id=?`, [payload.id]);
      await persistDb();
      return { ok: true };

    case 'run_action_rule': {
      const rule = sqlQuery(`SELECT * FROM action_rule WHERE id=?`, [payload.id])[0];
      if (!rule) return { ok: false, error: 'Rule not found' };
      return { ok: true, affected: await executeActionRule(rule) };
    }

    case 'run_auto_actions': {
      let total = 0;
      for (const rule of sqlQuery(`SELECT * FROM action_rule WHERE is_auto=1 ORDER BY position, id`)) {
        total += await executeActionRule(rule);
      }
      return { ok: true, total };
    }

    // Moves matching leaf tabs into a new window: open tabs chrome-move (sentinels keep
    // our own events from re-reparenting), saved tabs reopen fresh reusing their nodes.
    case 'open_search_in_window': {
      const { where, params } = buildSearchWhere(payload.q);
      const tabs = sqlQuery(
        `SELECT id, url, is_open, chrome_id FROM node WHERE (${where}) AND ${LEAF_TABS} LIMIT 50`,
        params
      );
      if (!tabs.length) return { ok: true, moved: 0 };
      const open  = tabs.filter(t => t.is_open && t.chrome_id);
      const saved = tabs.filter(t => !t.is_open || !t.chrome_id);

      let newWin;
      if (open.length) {
        bgState.movingTabIds.set(open[0].chrome_id, Date.now());
        newWin = await chrome.windows.create({ tabId: open[0].chrome_id });
        for (const t of open.slice(1)) {
          bgState.movingTabIds.set(t.chrome_id, Date.now());
          try { await chrome.tabs.move(t.chrome_id, { windowId: newWin.id, index: -1 }); } catch {}
        }
      } else {
        newWin = await chrome.windows.create({ url: saved[0].url });
        bgState.adoptedTabIds.add(newWin.tabs[0].id);
      }

      let winNodeId = sqlQuery(`SELECT id FROM node WHERE chrome_id=? AND node_type='win' LIMIT 1`, [newWin.id])[0]?.id;
      if (!winNodeId) {
        winNodeId = sqlInsert(
          `INSERT INTO node (node_type, is_open, is_saved, chrome_id, win_rect, relicons, parent_id, order_by)
           VALUES ('win',1,0,?,?,?,NULL,${NEXT_ROOT_ORDER})`,
          [newWin.id, `${newWin.left}_${newWin.top}_${newWin.width}_${newWin.height}`, newWin.type ?? 'normal']
        );
      }

      const pairs = open.map(t => [t.id, t.chrome_id]);
      let rest = saved;
      if (!open.length && saved.length) {
        pairs.push([saved[0].id, newWin.tabs[0].id]);
        rest = saved.slice(1);
      }
      for (const t of rest) {
        const nt = await chrome.tabs.create({ windowId: newWin.id, url: t.url, active: false });
        bgState.adoptedTabIds.add(nt.id);
        pairs.push([t.id, nt.id]);
      }

      sqlExec(`DROP TABLE IF EXISTS tmp_open; CREATE TEMP TABLE tmp_open (node_id INTEGER PRIMARY KEY, chrome_id INTEGER, pos INTEGER);`);
      sqlRun(
        `INSERT INTO tmp_open VALUES ${pairs.map(() => '(?,?,?)').join(',')}`,
        pairs.flatMap((p, i) => [p[0], p[1], i])
      );
      sqlExec(`
        UPDATE node SET chrome_id=NULL, is_open=0
          WHERE node_type='tab' AND chrome_id IN (SELECT chrome_id FROM tmp_open)
            AND id NOT IN (SELECT node_id FROM tmp_open);
        UPDATE node SET
            chrome_id = (SELECT chrome_id FROM tmp_open o WHERE o.node_id = node.id),
            position  = (SELECT pos       FROM tmp_open o WHERE o.node_id = node.id),
            order_by  = (SELECT pos       FROM tmp_open o WHERE o.node_id = node.id),
            parent_id = ${Math.trunc(+winNodeId)}, is_open=1
          WHERE id IN (SELECT node_id FROM tmp_open);
        DROP TABLE tmp_open;
      `);
      await persistDb();
      return { ok: true, moved: tabs.length };
    }

    // Moves a node's subtree under a fresh root-level win node. Its open tabs (DFS
    // order) follow in Chrome into a new window built around the first; closed ones
    // stay closed. Live Chrome groups in the subtree drop their chrome identity first
    // (becoming plain folders) so the emptied group's onRemoved can't delete them.
    case 'move_to_new_window': {
      const id = Math.trunc(+payload.id);
      const src = sqlQuery(`SELECT parent_id, node_type, is_open, chrome_id FROM node WHERE id=?`, [id])[0];
      if (!src || src.node_type === 'win') throw new Error('Only non-window nodes can move to a new window');
      const tabIds = [
        ...(src.node_type === 'tab' && src.is_open && src.chrome_id ? [src.chrome_id] : []),
        ...getRecursiveOpenChildren(id).map(t => t.chrome_id),
      ];
      const winId = sqlInsert(
        `INSERT INTO node (node_type, is_open, is_saved, parent_id, order_by) VALUES ('win',0,?,NULL,${NEXT_ROOT_ORDER})`,
        [tabIds.length ? 0 : 1]
      );
      sqlRun(`UPDATE node SET parent_id=?, order_by=0 WHERE id=?`, [winId, id]);
      sqlRun(`
        UPDATE node SET chrome_id=NULL, is_open=0
        WHERE node_type='group' AND chrome_id IS NOT NULL AND id IN (
          WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT n.id FROM node n JOIN d ON n.parent_id = d.id)
          SELECT id FROM d)`, [id]);
      renumberOrderBy([src.parent_id]);
      await chromeMoveIntoWin(winId, tabIds);
      await persistDb();
      return { ok: true, moved: tabIds.length };
    }

    case 'save_close_search': {
      const { where, params } = buildSearchWhere(payload.q);
      const rows = sqlQuery(
        `SELECT id, chrome_id, is_open FROM node WHERE (${where}) AND ${LEAF_TABS} LIMIT 200`,
        params
      );
      if (!rows.length) return { ok: true, count: 0 };
      sqlRun(
        `UPDATE node SET is_saved=1, is_open=0, chrome_id=NULL
         WHERE id IN (${rows.map(r => Math.trunc(+r.id)).join(',')})`
      );
      await persistDb();
      const closeIds = rows.filter(r => r.is_open && r.chrome_id).map(r => r.chrome_id);
      if (closeIds.length) { try { await chrome.tabs.remove(closeIds); } catch {} }
      return { ok: true, count: rows.length };
    }

    case 'close_search': {
      const { where, params } = buildSearchWhere(payload.q);
      const rows = sqlQuery(
        `SELECT chrome_id FROM node WHERE (${where}) AND ${LEAF_TABS} AND is_open=1 AND chrome_id IS NOT NULL LIMIT 200`,
        params
      );
      if (rows.length) { try { await chrome.tabs.remove(rows.map(r => r.chrome_id)); } catch {} }
      return { ok: true, count: rows.length };
    }

    // ── Config k/v ───────────────────────────────────────────────────────────
    case 'get_config': {
      if (payload.key) {
        return { ok: true, value: sqlQuery(`SELECT value FROM config WHERE key=?`, [payload.key])[0]?.value ?? null };
      }
      return { ok: true, values: Object.fromEntries(sqlQuery(`SELECT key, value FROM config`).map(r => [r.key, r.value])) };
    }

    case 'set_config': {
      const entries = payload.key !== undefined ? { [payload.key]: payload.value } : (payload.entries ?? {});
      const kv = Object.entries(entries);
      if (kv.length) {
        sqlRun(`INSERT OR REPLACE INTO config (key, value) VALUES ${kv.map(() => '(?,?)').join(',')}`, kv.flat());
      }
      await persistDb();
      return { ok: true };
    }

    // ── Schema info ──────────────────────────────────────────────────────────
    case 'get_schema': {
      const result = {};
      for (const t of sqlQuery(`SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY type, name`)) {
        try { result[t.name] = sqlQuery(`PRAGMA table_info(${t.name})`); } catch {}
      }
      return { ok: true, schema: result };
    }

    case 'resync': {
      await resync();
      if (!payload?.dedupe) return { ok: true };
      const merged = await dedupeWindows();
      if (merged) { renumberOrderBy(); await persistDb(); }
      return { ok: true, merged };
    }

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
