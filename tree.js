// tree.js — entry point; imports all modules then boots
'use strict';

import { load } from './js/render.js';
import { loadQuickQueries, loadSqlSchema, runSQL, sqlQuickEl, sqlEditor } from './js/sql-panel.js';
import { loadTheme, buildColorGrid, loadDateFormat } from './js/config.js';
import './js/events.js';
import './js/tags.js';
import './js/actions-cfg.js';

loadDateFormat().catch(console.error).finally(load);

loadQuickQueries().then(() => {
  const first = sqlQuickEl.options[1];
  if (first?.dataset.sql) {
    sqlEditor.value = first.dataset.sql;
    runSQL(first.dataset.sql);
  }
});

loadSqlSchema().catch(console.error);

loadTheme().then(theme => buildColorGrid(theme)).catch(console.error);
