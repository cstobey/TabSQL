"""
db/factory.py - Instantiate backend from config.
"""
from __future__ import annotations
import json
from pathlib import Path
from base import BaseBackend


def load_config(config_path: str | Path | None = None) -> dict:
    if config_path is None:
        config_path = Path(__file__).parent / "config.json"
    return json.loads(Path(config_path).read_text())


def make_backend(config: dict | None = None) -> BaseBackend:
    if config is None:
        config = load_config()

    backend = config.get("backend", "sqlite")

    if backend == "sqlite":
        from sqlite import SQLiteBackend
        return SQLiteBackend(path=config["sqlite"]["path"])

    elif backend == "mariadb":
        from mariadb import MariaDBBackend
        m = config["mariadb"]
        return MariaDBBackend(
            host=m.get("host", "127.0.0.1"),
            port=m.get("port", 3306),
            user=m["user"],
            password=m["password"],
            database=m.get("database", "tabsql"),
        )

    else:
        raise ValueError(f"Unknown backend: {backend!r}. Use 'sqlite' or 'mariadb'.")
