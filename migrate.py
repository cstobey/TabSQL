#!/usr/bin/env python3
"""
migrate.py - Import a Tab Outliner .tree export into the database.

The .tree format is a flat JSON array:
  [TREE_CREATE_op, NODE_INSERT, NODE_INSERT, ..., EOF]

Each NODE_INSERT is: [2001, nodeObj, pathArray]
  pathArray = child indices at each level, e.g. [0, 2, 1] means
  root.children[0].children[2].children[1] = this node's position

Usage:
  python migrate.py --tree path/to/export.tree [--config path/to/config.json] [--dry-run]
"""
from __future__ import annotations
import argparse
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / 'daemon'))
from db import make_backend
from db.factory import load_config

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger(__name__)

NODE_INSERT    = 2001
NODE_NEWROOT   = 2000
EOF_OP         = 11111


def parse_node(raw: dict) -> dict:
    """Flatten a raw node object from the .tree format into our schema columns."""
    ntype  = raw.get('type', 'savedtab')
    marks  = raw.get('marks', {})
    data   = raw.get('data') or {}

    return {
        'node_type':     ntype,
        'is_collapsed':  1 if raw.get('colapsed') else 0,
        'is_open':       1 if ntype in ('win', 'tab') else 0,
        'title':         data.get('title'),
        'url':           data.get('url'),
        'favicon_url':   data.get('favIconUrl'),
        'note_text':     data.get('note'),
        'custom_title':  marks.get('customTitle'),
        'custom_favicon': marks.get('customFavicon'),
        'color_active':  marks.get('customColorActive'),
        'color_saved':   marks.get('customColorSaved'),
        'relicons':      json.dumps(marks.get('relicons', [])),
        'win_rect':      data.get('rect'),
        'chrome_id':     data.get('id'),  # only meaningful for live tabs
    }


def migrate(tree_path: str, config: dict, dry_run: bool = False) -> None:
    raw = json.loads(Path(tree_path).read_text(encoding='utf-8'))
    if not isinstance(raw, list):
        raise ValueError("Unexpected .tree format: root is not a list")

    db = make_backend(config)
    db.connect()
    if not dry_run:
        db.init_schema()

    # id_map: path_tuple -> db_id
    # We process inserts in order; pathArray tells us where in the tree.
    # We maintain a mapping from path -> db_id to resolve parent_id.
    path_to_id: dict[tuple, int] = {}
    # position counters per parent path
    from collections import defaultdict
    position_counter: dict[tuple, int] = defaultdict(int)

    stats = {'inserted': 0, 'skipped': 0, 'errors': 0}

    for item in raw:
        if not isinstance(item, list):
            # TREE_CREATE dict
            continue

        op = item[0]
        if op != NODE_INSERT:
            continue

        if len(item) < 3:
            stats['skipped'] += 1
            continue

        raw_node = item[1]
        path     = tuple(item[2])  # e.g. (0, 2, 1)

        node = parse_node(raw_node)

        parent_path = path[:-1]
        parent_id   = path_to_id.get(parent_path)  # None for root

        node['parent_id'] = parent_id
        node['position']  = position_counter[parent_path]
        position_counter[parent_path] += 1

        # Strip None values to let DB defaults apply
        node = {k: v for k, v in node.items() if v is not None}

        try:
            if dry_run:
                node_id = stats['inserted'] + 1  # fake id
                log.debug("DRY  path=%s type=%s title=%s",
                          path, node.get('node_type'), node.get('title','')[:60])
            else:
                node_id = db.upsert_node(node)
            path_to_id[path] = node_id
            stats['inserted'] += 1
        except Exception as e:
            log.error("Failed at path=%s type=%s: %s", path, node.get('node_type'), e)
            stats['errors'] += 1

    db.close()
    log.info("Migration complete: inserted=%d skipped=%d errors=%d",
             stats['inserted'], stats['skipped'], stats['errors'])


def main() -> None:
    ap = argparse.ArgumentParser(description="Migrate Tab Outliner .tree export to DB")
    ap.add_argument('--tree',    required=True, help=".tree export file")
    ap.add_argument('--config',  default=None,  help="config.json path")
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    config_path = args.config or (Path(__file__).parent / 'daemon' / 'config.json')
    config = load_config(config_path)
    migrate(args.tree, config, dry_run=args.dry_run)


if __name__ == '__main__':
    main()
