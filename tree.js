// tree.js — entry point; imports all modules then boots
'use strict';

import { load } from './js/render.js';
import { loadQuickQueries, runSQL, sqlQuickEl } from './js/sql-panel.js';
import { loadTheme, buildColorGrid } from './js/config.js';
import './js/events.js';
import './js/tags.js';
import './js/actions-cfg.js';

load();

loadQuickQueries().then(() => {
  const first = sqlQuickEl.options[1];
  if (first?.dataset.sql) {
    document.getElementById('sql-input').value = first.dataset.sql;
    runSQL(first.dataset.sql);
  }
});

loadTheme().then(theme => buildColorGrid(theme)).catch(console.error);
