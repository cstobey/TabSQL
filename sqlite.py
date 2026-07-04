"""
db/sqlite.py - SQLite backend.
"""
from __future__ import annotations
import sqlite3
from pathlib import Path
from base import BaseBackend


class SQLiteBackend(BaseBackend):

    def __init__(self, path: str):
        self.path = Path(path).expanduser()
        self._conn: sqlite3.Connection | None = None

    def connect(self) -> None:
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    @property
    def _c(self) -> sqlite3.Connection:
        if self._conn is None:
            raise RuntimeError("Not connected")
        return self._conn

    def execute(self, sql: str, params: tuple = ()) -> list[dict]:
        cur = self._c.execute(sql, params)
        if cur.description:
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]
        return []

    def executemany(self, sql: str, rows: list[tuple]) -> None:
        self._c.executemany(sql, rows)

    def commit(self) -> None:
        self._c.commit()

    def insert_returning_id(self, sql: str, params: tuple) -> int:
        cur = self._c.execute(sql, params)
        self._c.commit()
        return cur.lastrowid

    def init_schema(self) -> None:
        schema = Path(__file__).parent / "schema_sqlite.sql"
        self._c.executescript(schema.read_text())
        self._c.commit()
