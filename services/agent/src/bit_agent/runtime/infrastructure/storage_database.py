"""SQLite 接入、表结构和本地数据目录。"""

import os
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

SCHEMA = """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, workspace TEXT NOT NULL, title TEXT NOT NULL,
                mode TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
                created_at TEXT NOT NULL, data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS tasks_session ON tasks(session_id, created_at);
            CREATE TABLE IF NOT EXISTS context_state (
                session_id TEXT PRIMARY KEY, data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS working_memory (
                thread_id TEXT PRIMARY KEY, data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
                event_type TEXT NOT NULL, data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);
            CREATE TABLE IF NOT EXISTS transcript (
                id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS user_answers (
                question_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
                data TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS user_answers_task ON user_answers(task_id);
            CREATE TABLE IF NOT EXISTS turn_checkpoints (
                session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
                context TEXT, memory TEXT
            );
        """


def now() -> str:
    return datetime.now(UTC).isoformat()


def default_data_directory() -> Path:
    configured = os.getenv("BIT_AGENT_DATA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    base = Path(os.getenv("LOCALAPPDATA") or (Path.home() / ".local" / "share"))
    return base / "BitAgent" / "runtime"


def open_database(directory: Path) -> sqlite3.Connection:
    db = sqlite3.connect(directory / "sessions.sqlite3", timeout=15, check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    if db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoints'"
    ).fetchone():
        db.execute("ALTER TABLE checkpoints RENAME TO context_state")
    db.executescript(SCHEMA)
    db.commit()
    return db
