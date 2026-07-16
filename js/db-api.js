export const db = {
  async send(cmd, payload = {}) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('background not responding')), 8000);
      chrome.runtime.sendMessage({ to: 'background', cmd, payload }, r => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
        else if (r?.ok === false) rej(new Error(r.error));
        else res(r?.data);
      });
    });
  },
  query(sql)                        { return this.send('bulk_exec', { sql }); },
  deleteNode(id)                    { return this.send('delete_node', { id }); },
  moveNode(id, parent_id, order_by) { return this.send('move_node', { id, parent_id, order_by }); },
  upsertNode(node)                  { return this.send('upsert_node', { node }); },
  preOpenTab(nodeId, url)           { return this.send('pre_open_tab', { nodeId, url }); },
  resync()                          { return this.send('resync'); },
};
