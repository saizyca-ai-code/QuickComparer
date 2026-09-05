"""設定的持久化。

Phase 1 只存專案資料夾一項，但這裡就用 SQLite 而不是 JSON 檔 —— Phase 3 的
全域媒體庫索引會用同一個資料庫，屆時只是加表，不必搬家。
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .paths import DB_PATH, ensure_data_dir

_SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    ensure_data_dir()
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.row_factory = sqlite3.Row
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with connect() as conn:
        conn.executescript(_SCHEMA)


def get_setting(key: str) -> str | None:
    with connect() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return None if row is None else str(row["value"])


def set_setting(key: str, value: str) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


PROJECT_DIR_KEY = "project_dir"


def get_project_dir() -> Path | None:
    raw = get_setting(PROJECT_DIR_KEY)
    return None if raw is None else Path(raw)


def set_project_dir(path: Path) -> None:
    set_setting(PROJECT_DIR_KEY, str(path))
