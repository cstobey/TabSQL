"""
db/mariadb.py - MariaDB backend via pymysql.
pip install pymysql
"""
from __future__ import annotations
from pathlib import Path
from .base import BaseBackend

try:
    import pymysql
    import pymysql.cursors
except ImportError:
    pymysql = None  # type: ignore


class MariaDBBackend(BaseBackend):

    def __init__(self, host: str, port: int, user: str, password: str, database: str):
        if pymysql is None:
            raise RuntimeError("pymysql not installed: pip install pymysql")
        self.cfg = dict(host=host, port=port, user=user, password=password,
                        database=database, charset='utf8mb4',
                        cursorclass=pymysql.cursors.DictCursor,
                        autocommit=False)
        self._conn = None

    def connect(self) -> None:
        self._conn = pymysql.connect(**self.cfg)

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    @property
    def _c(self):
        if self._conn is None:
            raise RuntimeError("Not connected")
        return self._conn

    def execute(self, sql: str, params: tuple = ()) -> list[dict]:
        # Translate SQLite ? placeholders to %s
        sql = sql.replace('?', '%s')
        # MariaDB datetime default differs; strip SQLite-isms
        with self._c.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall() or []

    def executemany(self, sql: str, rows: list[tuple]) -> None:
        sql = sql.replace('?', '%s')
        with self._c.cursor() as cur:
            cur.executemany(sql, rows)

    def commit(self) -> None:
        self._c.commit()

    def insert_returning_id(self, sql: str, params: tuple) -> int:
        sql = sql.replace('?', '%s')
        with self._c.cursor() as cur:
            cur.execute(sql, params)
            self._c.commit()
            return cur.lastrowid

    def move_node(self, node_id: int, new_parent_id: int, new_position: int) -> None:
        # Override: MariaDB uses NOW() not datetime('now')
        self.execute(
            "UPDATE node SET parent_id = %s, position = %s, updated_at = NOW() WHERE id = %s",
            (new_parent_id, new_position, node_id)
        )
        self.commit()

    def init_schema(self) -> None:
        schema = Path(__file__).parent.parent.parent / "sql" / "schema_mariadb.sql"
        sql = schema.read_text()
        with self._c.cursor() as cur:
            for statement in sql.split(';'):
                s = statement.strip()
                if s:
                    cur.execute(s)
        self._c.commit()
