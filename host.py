#!/usr/bin/env python3
"""
host.py - Native messaging host + HTTP management endpoint.

Chrome native messaging protocol: each message is prefixed by a 4-byte
little-endian uint32 length, then UTF-8 JSON. Responses same format.

Also runs a simple HTTP server on config.http_port for management UI / ad-hoc SQL.
"""
from __future__ import annotations
import json
import logging
import struct
import sys
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer

from db import make_backend
from db.factory import load_config

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def setup_logging(log_file: str) -> None:
    path = Path(log_file).expanduser()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(path), logging.StreamHandler(sys.stderr)],
    )

# ---------------------------------------------------------------------------
# Native messaging I/O
# ---------------------------------------------------------------------------

def read_message(stream=sys.stdin.buffer) -> dict | None:
    raw_len = stream.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack('<I', raw_len)[0]
    data = stream.read(msg_len)
    return json.loads(data.decode('utf-8'))


def write_message(obj: dict, stream=sys.stdout.buffer) -> None:
    data = json.dumps(obj).encode('utf-8')
    stream.write(struct.pack('<I', len(data)))
    stream.write(data)
    stream.flush()

# ---------------------------------------------------------------------------
# Message dispatch
# ---------------------------------------------------------------------------

def handle_message(msg: dict, db) -> dict:
    cmd = msg.get('cmd')
    try:
        if cmd == 'ping':
            return {'ok': True, 'pong': True}

        elif cmd == 'get_tree':
            parent_id = msg.get('parent_id')
            rows = db.get_tree(parent_id)
            return {'ok': True, 'rows': rows}

        elif cmd == 'upsert_node':
            node_id = db.upsert_node(msg['node'])
            return {'ok': True, 'id': node_id}

        elif cmd == 'delete_node':
            db.delete_node(msg['id'])
            return {'ok': True}

        elif cmd == 'move_node':
            db.move_node(msg['id'], msg['parent_id'], msg['position'])
            return {'ok': True}

        elif cmd == 'bulk_exec':
            rows = db.bulk_exec(msg['sql'])
            return {'ok': True, 'rows': rows}

        elif cmd == 'get_node':
            rows = db.execute("SELECT * FROM node WHERE id = ?", (msg['id'],))
            return {'ok': True, 'row': rows[0] if rows else None}

        elif cmd == 'search':
            q = f"%{msg['q']}%"
            rows = db.execute(
                "SELECT * FROM node WHERE title LIKE ? OR url LIKE ? OR note_text LIKE ? LIMIT 200",
                (q, q, q)
            )
            return {'ok': True, 'rows': rows}

        else:
            return {'ok': False, 'error': f'Unknown command: {cmd}'}

    except Exception as e:
        logging.exception("handle_message error")
        return {'ok': False, 'error': str(e)}

# ---------------------------------------------------------------------------
# HTTP management server
# ---------------------------------------------------------------------------

class ManagementHandler(BaseHTTPRequestHandler):
    db = None  # injected at startup

    def log_message(self, fmt, *args):
        logging.debug(fmt, *args)

    def _json(self, obj: dict, status: int = 200) -> None:
        body = json.dumps(obj, default=str).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self._json({'ok': True})
        elif self.path == '/tree':
            rows = self.db.get_tree()
            self._json({'ok': True, 'rows': rows})
        elif self.path.startswith('/node/'):
            nid = int(self.path.split('/')[-1])
            rows = self.db.execute("SELECT * FROM node WHERE id = ?", (nid,))
            self._json({'ok': True, 'row': rows[0] if rows else None})
        else:
            self._json({'error': 'Not found'}, 404)

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length))

        if self.path == '/query':
            try:
                rows = self.db.bulk_exec(body['sql'])
                self._json({'ok': True, 'rows': rows})
            except Exception as e:
                self._json({'ok': False, 'error': str(e)}, 400)

        elif self.path == '/message':
            result = handle_message(body, self.db)
            self._json(result)

        else:
            self._json({'error': 'Not found'}, 404)


def start_http(db, port: int) -> None:
    ManagementHandler.db = db
    server = HTTPServer(('127.0.0.1', port), ManagementHandler)
    logging.info("HTTP management server on http://127.0.0.1:%d", port)
    server.serve_forever()

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    config = load_config()
    setup_logging(config.get('log_file', '~/taboutliner_daemon.log'))
    logging.info("Tab Outliner daemon starting")

    db = make_backend(config)
    db.connect()
    db.init_schema()
    logging.info("DB connected (%s)", config.get('backend'))

    http_port = config.get('http_port', 7779)
    t = threading.Thread(target=start_http, args=(db, http_port), daemon=True)
    t.start()

    # Native messaging loop
    while True:
        msg = read_message()
        if msg is None:
            logging.info("stdin closed, exiting")
            break
        response = handle_message(msg, db)
        write_message(response)

    db.close()


if __name__ == '__main__':
    main()
