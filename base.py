"""
db/base.py - Backend protocol / abstract base.
All backends must implement this interface.
"""
from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Any


class BaseBackend(ABC):

    @abstractmethod
    def connect(self) -> None: ...

    @abstractmethod
    def close(self) -> None: ...

    @abstractmethod
    def execute(self, sql: str, params: tuple = ()) -> list[dict]: ...

    @abstractmethod
    def executemany(self, sql: str, rows: list[tuple]) -> None: ...

    @abstractmethod
    def commit(self) -> None: ...

    @abstractmethod
    def init_schema(self) -> None: ...

    # ------------------------------------------------------------------ #
    # Higher-level ops (shared implementation on top of execute/commit)   #
    # ------------------------------------------------------------------ #

    def upsert_node(self, node: dict) -> int:
        """Insert or replace a node. Returns its id."""
        cols = [k for k in node if k != 'id']
        if 'id' in node:
            set_clause = ', '.join(f"{c} = ?" for c in cols)
            self.execute(
                f"UPDATE node SET {set_clause} WHERE id = ?",
                tuple(node[c] for c in cols) + (node['id'],)
            )
            self.commit()
            return node['id']
        else:
            placeholders = ', '.join('?' for _ in cols)
            col_names = ', '.join(cols)
            return self.insert_returning_id(
                f"INSERT INTO node ({col_names}) VALUES ({placeholders})",
                tuple(node[c] for c in cols)
            )

    @abstractmethod
    def insert_returning_id(self, sql: str, params: tuple) -> int: ...

    def delete_node(self, node_id: int) -> None:
        self.execute("DELETE FROM node WHERE id = ?", (node_id,))
        self.commit()

    def get_tree(self, parent_id: int | None = None) -> list[dict]:
        if parent_id is None:
            return self.execute(
                "SELECT * FROM node WHERE parent_id IS NULL ORDER BY position"
            )
        return self.execute(
            "SELECT * FROM node WHERE parent_id = ? ORDER BY position",
            (parent_id,)
        )

    def move_node(self, node_id: int, new_parent_id: int, new_position: int) -> None:
        self.execute(
            "UPDATE node SET parent_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?",
            (new_parent_id, new_position, node_id)
        )
        self.commit()

    def bulk_exec(self, sql: str) -> list[dict]:
        """Execute arbitrary SQL; for ad-hoc / management use."""
        return self.execute(sql)

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *_):
        self.close()
