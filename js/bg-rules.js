import { buildSearchWhere, sqlQuery, sqlRun, upsertNode, persistDb } from './bg-db.js';

export async function executeActionRule(rule) {
  let nodes = [];
  if (rule.condition_type === 'search') {
    const { where, params } = buildSearchWhere(rule.condition);
    nodes = sqlQuery(`SELECT * FROM node WHERE ${where} LIMIT 1000`, params);
  } else {
    try { nodes = sqlQuery(rule.condition); } catch { return 0; }
  }

  const cfg = rule.config ? JSON.parse(rule.config) : {};
  let count = 0;

  if (rule.action_type === 'add_tag' && cfg.tag_id) {
    for (const n of nodes) {
      sqlRun('INSERT OR IGNORE INTO node_tag (node_id, tag_id) VALUES (?,?)', [n.id, cfg.tag_id]);
      count++;
    }
  } else if (rule.action_type === 'delete') {
    const delayDays = +(cfg.delay_days ?? 0);
    for (const n of nodes) {
      if (delayDays > 0) {
        const rows = sqlQuery(
          `SELECT id FROM node WHERE id=? AND updated_at <= datetime('now', '-${delayDays} days')`,
          [n.id]
        );
        if (!rows.length) continue;
      }
      sqlRun('DELETE FROM node_tag WHERE node_id=?', [n.id]);
      sqlRun('DELETE FROM win_auto_tag WHERE win_node_id=?', [n.id]);
      sqlRun('DELETE FROM node WHERE id=?', [n.id]);
      count++;
    }
  } else if (rule.action_type === 'move' && cfg.target_win_id) {
    const kids = sqlQuery('SELECT COUNT(*) c FROM node WHERE parent_id=?', [cfg.target_win_id]);
    let pos = kids[0]?.c ?? 0;
    for (const n of nodes) {
      if (n.node_type === 'tab') {
        sqlRun(`UPDATE node SET parent_id=?, position=?, updated_at=datetime('now') WHERE id=?`,
               [cfg.target_win_id, pos++, n.id]);
        count++;
      }
    }
  } else if (rule.action_type === 'save_on_close') {
    for (const n of nodes) {
      if (n.node_type === 'tab' && n.is_open && !n.is_saved) {
        sqlRun(`UPDATE node SET is_saved=1, is_open=0, chrome_id=NULL, updated_at=datetime('now') WHERE id=?`, [n.id]);
        if (n.chrome_id) { try { await chrome.tabs.remove(n.chrome_id); } catch {} }
        count++;
      }
    }
  }
  await persistDb();
  return count;
}
