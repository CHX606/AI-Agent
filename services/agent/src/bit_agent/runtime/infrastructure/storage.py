"""保存本地对话。关闭程序不会清空数据，也没有一天后自动删除的限制。"""

import asyncio
import json
import os
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from bit_agent.context.manager import CONTEXT_SUMMARY_PREFIX
from bit_agent.memory.models import TestStatus, WorkingMemory
from bit_agent.observability.diagnostics import failure, public_error, safe_fields
from bit_agent.runtime.application.ports import StoragePort


def now() -> str:
    return datetime.now(UTC).isoformat()


def default_data_directory() -> Path:
    configured = os.getenv("BIT_AGENT_DATA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    base = Path(os.getenv("LOCALAPPDATA") or (Path.home() / ".local" / "share"))
    return base / "BitAgent" / "runtime"


class LocalStorage:
    """所有数据库读写都从这里经过，上层不用到处拼 SQL。"""

    def __init__(self, directory: Path) -> None:
        self.directory = directory.resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(
            self.directory / "sessions.sqlite3",
            timeout=15,
            check_same_thread=False,
        )
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        # 旧表直接改名，不复制一张新表。旧记录在首次读取时拆开，见 _migrate_session。
        if self._db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoints'"
        ).fetchone():
            self._db.execute("ALTER TABLE checkpoints RENAME TO context_state")
        self._db.executescript("""
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
        """)
        self._db.commit()

    async def call(self, operation: str, *args: Any) -> Any:
        # 磁盘读写放到后台线程，避免保存记录时卡住取消任务、接收消息等操作。
        return await asyncio.to_thread(self._call, operation, args)

    def _call(self, operation: str, args: tuple[Any, ...]) -> Any:
        try:
            with self._lock, self._db:
                return getattr(self, f"_{operation}")(*args)
        except Exception as exc:
            identifiers = safe_fields(args[0]) if args and isinstance(args[0], dict) else {}
            failure("storage_failed", exc, operation=operation,
                    **{k: v for k, v in identifiers.items() if k in {"task_id", "session_id"}})
            raise

    def _session(self, session_id: str) -> dict[str, Any] | None:
        row = self._db.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
        if row is None:
            return None
        return {
            "session_id": row["id"],
            "workspace_root": row["workspace"],
            "title": row["title"],
            "multi_agent_mode": row["mode"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def _create(self, task: dict[str, Any]) -> None:
        session_id = task["session_id"]
        existing = self._session(session_id)
        if existing is None:
            self._db.execute(
                "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    task["workspace_root"],
                    task["objective"][:100],
                    task["multi_agent_mode"],
                    task["created_at"],
                    task["created_at"],
                ),
            )
        self._db.execute(
            "UPDATE sessions SET mode=?, updated_at=? WHERE id=?",
            (task["multi_agent_mode"], task["created_at"], session_id),
        )
        self._db.execute(
            "INSERT INTO tasks VALUES (?, ?, ?, ?, ?)",
            (
                task["task_id"],
                session_id,
                task["status"],
                task["created_at"],
                json.dumps(task, ensure_ascii=False),
            ),
        )

    def _get_task(self, task_id: str) -> dict[str, Any] | None:
        row = self._db.execute("SELECT data FROM tasks WHERE id=?", (task_id,)).fetchone()
        return json.loads(row["data"]) if row else None

    def _update_task(self, task_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        task = self._get_task(task_id)
        if task is None:
            raise ValueError("任务不存在")
        if task["status"] in {"COMPLETED", "PARTIAL", "FAILED", "CANCELLED"}:
            return task
        if task["status"] == "CANCELLATION_REQUESTED" and changes.get("status") in {
            "RUNNING",
            "QUEUED",
            "PAUSE_REQUESTED",
            "PAUSED",
            "WAITING_FOR_INPUT",
        }:
            return task
        task.update(changes, updated_at=now())
        self._db.execute(
            "UPDATE tasks SET status=?, data=? WHERE id=?",
            (task["status"], json.dumps(task, ensure_ascii=False), task_id),
        )
        self._db.execute(
            "UPDATE sessions SET updated_at=? WHERE id=?",
            (task["updated_at"], task["session_id"]),
        )
        return task

    def _answer_task(
        self, task_id: str, changes: dict[str, Any], question: dict[str, Any]
    ) -> dict[str, Any]:
        """确认接收回答与保存待恢复输入属于同一次事务。"""
        task = self._update_task(task_id, changes)
        answer = changes["last_answer"]
        if (
            task["status"] == "RUNNING"
            and task.get("last_answer") == answer
            and not question.get("requires_confirmation")
            and "operation" not in question
            and answer.get("source") == "user"
        ):
            update = {
                "id": "answer_" + question["id"],
                "kind": "supplement",
                "text": f"用户对问题「{question['question']}」的回答：{answer['text']}",
                "accepted_at": now(),
            }
            self._db.execute(
                "INSERT OR IGNORE INTO user_answers(question_id, task_id, data) VALUES (?, ?, ?)",
                (question["id"], task_id, json.dumps(update, ensure_ascii=False)),
            )
        return task

    def _task_inputs(
        self, task: dict[str, Any], *, pending_answers_only: bool = False
    ) -> list[dict[str, str]]:
        rows = self._db.execute(
            "SELECT data FROM user_answers WHERE task_id=?"
            + (" AND applied=0" if pending_answers_only else "")
            + " ORDER BY rowid",
            (task["task_id"],),
        ).fetchall()
        return sorted(
            [*task.get("intent_updates", []), *(json.loads(row["data"]) for row in rows)],
            key=lambda update: update.get("accepted_at", task["created_at"]),
        )

    def _list_sessions(self, limit: int = 200, offset: int = 0) -> dict[str, Any]:
        rows = self._db.execute(
            "SELECT id FROM sessions ORDER BY updated_at DESC, id LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
        sessions = []
        for row in rows:
            session = self._session(row["id"])
            latest = self._db.execute(
                "SELECT data FROM tasks WHERE session_id=? "
                "ORDER BY created_at DESC, rowid DESC LIMIT 1",
                (row["id"],),
            ).fetchone()
            if session is not None:
                task = json.loads(latest["data"]) if latest else None
                session["latest_task"] = (
                    None
                    if task is None
                    else {
                        key: task.get(key)
                        for key in ("task_id", "status", "objective", "created_at")
                    }
                )
                sessions.append(session)
        return {"sessions": sessions, "next_offset": offset + limit if len(rows) == limit else None}

    def _get_session(self, session_id: str) -> dict[str, Any] | None:
        session = self._session(session_id)
        if session is None:
            return None
        rows = self._db.execute(
            "SELECT data FROM tasks WHERE session_id=? ORDER BY created_at, rowid",
            (session_id,),
        ).fetchall()
        # 页面只需要对话文字，不把所有工具日志重复传给页面。
        turns = []
        for row in rows:
            task = json.loads(row["data"])
            result = task.get("result") or {}
            turns.append(
                {
                    "task_id": task["task_id"],
                    "objective": task["objective"],
                    "status": task["status"],
                    "created_at": task["created_at"],
                    "final_answer": result.get("final_answer") or task.get("error") or "",
                    "intent_updates": self._task_inputs(task),
                }
            )
        return {"session": session, "turns": turns}

    def _set_mode(self, session_id: str, mode: str) -> dict[str, Any] | None:
        self._db.execute("UPDATE sessions SET mode=? WHERE id=?", (mode, session_id))
        return self._session(session_id)

    def _save_progress(
        self, session_id: str, context: dict[str, Any], memory: WorkingMemory
    ) -> None:
        """上下文、任务状态各写一次；由 _call 的同一次事务保证同时落盘。"""
        if memory.thread_id != session_id:
            raise ValueError("上下文与任务状态必须属于同一个会话")
        if set(context) != {"history"} or not isinstance(context["history"], list):
            raise ValueError("context_state 只保存上下文历史，不能夹带任务状态")
        self._db.execute(
            "INSERT OR REPLACE INTO context_state VALUES (?, ?)",
            (session_id, json.dumps(context, ensure_ascii=False)),
        )
        self._save_memory(memory)
        self._acknowledge_answers(session_id, context["history"], memory)

    def _acknowledge_answers(
        self, session_id: str, history: list[Any], memory: WorkingMemory
    ) -> None:
        pending = self._db.execute(
            "SELECT a.question_id, a.data FROM user_answers a JOIN tasks t ON t.id=a.task_id "
            "WHERE t.session_id=? AND a.applied=0", (session_id,),
        ).fetchall()
        if not pending:
            return
        applied = set(memory.applied_interaction_ids)
        answered = set()
        for item in history:
            if not isinstance(item, dict) or item.get("type") != "function_call_output":
                continue
            try:
                result = json.loads(item.get("output", ""))
            except (ValueError, TypeError):
                continue
            if (
                isinstance(result, dict)
                and result.get("tool_name") == "ask_user"
                and result.get("status") == "SUCCESS"
                and isinstance(result.get("output"), dict)
                and result["output"].get("source") == "user"
                and isinstance(result["output"].get("question_id"), str)
            ):
                answered.add(result["output"]["question_id"])
        # 工具结果或恢复后的输入与确认消费一起落盘，之后压缩历史也不会重复回放。
        self._db.executemany(
            "UPDATE user_answers SET applied=1 WHERE question_id=?",
            [(row["question_id"],) for row in pending
             if row["question_id"] in answered or json.loads(row["data"])["id"] in applied],
        )

    def _migrate_session(self, session_id: str) -> None:
        """只整理旧格式，不碰其他会话；中途失败时，两张表都保持原样。"""
        context_row = self._db.execute(
            "SELECT data FROM context_state WHERE session_id=?", (session_id,)
        ).fetchone()
        memory_row = self._db.execute(
            "SELECT data FROM working_memory WHERE thread_id=?", (session_id,)
        ).fetchone()
        old_context = json.loads(context_row["data"]) if context_row else {}
        old_memory = json.loads(memory_row["data"]) if memory_row else {}
        if not (set(old_context) - {"history"} or "history_summary" in old_memory):
            return

        history = old_context.get("history", [])
        summary = old_memory.pop("history_summary", None)
        # 已经在历史里的摘要优先；旧版本只有工作记忆副本时，将它搬回上下文。
        if summary and not any(
            isinstance(item, dict)
            and item.get("role") == "developer"
            and str(item.get("content", "")).startswith(CONTEXT_SUMMARY_PREFIX)
            for item in history
        ):
            history.insert(
                0, {"role": "developer", "content": CONTEXT_SUMMARY_PREFIX + "\n" + summary}
            )

        intent = old_context.get("intent_state") or {}
        if not old_memory:
            first_task = self._db.execute(
                "SELECT data FROM tasks WHERE session_id=? ORDER BY created_at, rowid LIMIT 1",
                (session_id,),
            ).fetchone()
            objective = intent.get("objective") or (
                json.loads(first_task["data"])["objective"] if first_task else None
            )
            if not objective:
                raise ValueError("旧存档缺少任务目标，已保留原记录，没有用空状态覆盖")
            old_memory = {
                "thread_id": session_id,
                "objective": objective,
                "constraints": intent.get("constraints", []),
                "current_plan": intent.get("current_plan", []),
            }
        memory = WorkingMemory.model_validate(old_memory)
        memory.has_unverified_changes = old_context.get(
            "has_unverified_changes",
            memory.has_unverified_changes
            or memory.latest_test_status == TestStatus.NEEDS_VERIFICATION,
        )
        paths = list(dict.fromkeys(old_context.get("changed_files", memory.changed_files)))
        memory.verification_paths = paths if memory.has_unverified_changes else []
        memory.changed_files = list(dict.fromkeys([*memory.changed_files, *paths]))
        # 若两份旧状态不一致，不拿旧副本覆盖 Working Memory；重新读取已落盘的用户要求。
        intent_matches = not intent or all(
            intent.get(field, getattr(memory, field)) == getattr(memory, field)
            for field in ("objective", "constraints", "current_plan")
        )
        if intent_matches:
            memory.applied_interaction_ids = list(
                dict.fromkeys(
                    [
                        *memory.applied_interaction_ids,
                        *old_context.get("applied_interaction_ids", []),
                    ]
                )
            )
        self._save_progress(session_id, {"history": history}, memory)

    def _load_context(self, session_id: str) -> dict[str, Any]:
        self._migrate_session(session_id)
        row = self._db.execute(
            "SELECT data FROM context_state WHERE session_id=?",
            (session_id,),
        ).fetchone()
        return json.loads(row["data"]) if row else {"history": []}

    def _pending_intents(self, session_id: str) -> list[dict[str, str]]:
        memory = self._load_memory(session_id)
        applied = set(memory.applied_interaction_ids) if memory else set()
        rows = self._db.execute(
            "SELECT data FROM tasks WHERE session_id=? ORDER BY created_at, rowid",
            (session_id,),
        ).fetchall()
        # 用户要求先落盘。即使刚提交就关闭程序，下次续聊也不会漏掉它。
        return [
            update
            for task in rows
            for update in self._task_inputs(json.loads(task["data"]), pending_answers_only=True)
            if update["id"] not in applied
        ]

    def _acceptance_context(self, session_id: str) -> dict[str, Any]:
        """User-authored requirements only; never inherit the author's conclusions."""
        rows = self._db.execute(
            "SELECT data FROM tasks WHERE session_id=? ORDER BY created_at, rowid",
            (session_id,),
        ).fetchall()
        requirements = []
        for row in rows:
            task = json.loads(row["data"])
            requirements.append({"task_id": task["task_id"], "objective": task["objective"],
                                 "updates": self._task_inputs(task)})
        return {"user_requests": requirements}

    def _record_undo(self, session_id: str, paths: list[str], objective: str) -> None:
        context = self._load_context(session_id)
        memory = self._load_memory(session_id) or WorkingMemory(
            thread_id=session_id, objective=objective
        )
        context["history"].append(
            {
                "role": "user",
                "content": "用户已撤销改动。请重新读取文件，不能假定旧补丁仍存在。",
            }
        )
        memory.has_unverified_changes = True
        memory.basic_checks_passed = False
        memory.acceptance_status = "NOT_RUN"
        memory.verification_paths = sorted(set(memory.verification_paths) | set(paths))
        memory.changed_files = sorted(set(memory.changed_files) | set(paths))
        memory.latest_test_status = TestStatus.NEEDS_VERIFICATION
        memory.updated_at = datetime.now(UTC)
        self._save_progress(session_id, context, memory)

    def _append_items(self, task_id: str, items: list[Any]) -> None:
        self._db.execute(
            "INSERT INTO transcript(task_id, data) VALUES (?, ?)",
            (task_id, json.dumps(items, ensure_ascii=False)),
        )

    def _event(self, task_id: str, event_type: str, data: dict[str, Any]) -> None:
        data = {"timestamp": now(), **data}
        self._db.execute(
            "INSERT INTO events(task_id, event_type, data) VALUES (?, ?, ?)",
            (task_id, event_type, json.dumps(data, ensure_ascii=False)),
        )

    def _diagnostic_snapshot(self, task_id: str | None = None) -> dict[str, Any]:
        rows = self._db.execute(
            "SELECT data FROM tasks WHERE id=?" if task_id else
            "SELECT data FROM tasks ORDER BY created_at DESC LIMIT 50",
            (task_id,) if task_id else (),
        ).fetchall()
        tasks = []
        events = []
        for row in rows:
            task = json.loads(row["data"])
            safe_task = safe_fields(task)
            safe_task["phase_since"] = task.get("updated_at") or task["created_at"]
            latest = self._db.execute(
                "SELECT data FROM events WHERE task_id=? ORDER BY id DESC LIMIT 1",
                (task["task_id"],),
            ).fetchone()
            safe_task["last_activity"] = (
                json.loads(latest["data"]).get("timestamp") if latest else None
            )
            # Bounded projection of existing events; never export transcript, results or context.
            records = self._db.execute(
                "SELECT id,event_type,data FROM events WHERE task_id=? "
                "AND event_type != 'MODEL_TEXT_DELTA' ORDER BY id DESC LIMIT 200",
                (task["task_id"],),
            ).fetchall()
            for item in reversed(records):
                data = json.loads(item["data"])
                payload = data.get("payload", {})
                events.append({**safe_fields(data), **safe_fields(payload),
                               "event_id": item["id"], "event": item["event_type"],
                               "task_id": task["task_id"], "session_id": task["session_id"]})
            tasks.append(safe_task)
        return {"tasks": tasks, "events": events}

    def _read_events(self, task_id: str, after: int) -> list[dict[str, Any]]:
        rows = self._db.execute(
            "SELECT * FROM events WHERE task_id=? AND id>? ORDER BY id LIMIT 200",
            (task_id, after),
        ).fetchall()
        return [
            {
                "id": f"{row['id']}-0",
                "event_type": row["event_type"],
                "data": json.loads(row["data"]),
            }
            for row in rows
        ]

    def _save_memory(self, memory: WorkingMemory) -> None:
        self._db.execute(
            "INSERT OR REPLACE INTO working_memory VALUES (?, ?)",
            (memory.thread_id, memory.model_dump_json()),
        )

    def _load_memory(self, thread_id: str) -> WorkingMemory | None:
        self._migrate_session(thread_id)
        row = self._db.execute(
            "SELECT data FROM working_memory WHERE thread_id=?",
            (thread_id,),
        ).fetchone()
        return WorkingMemory.model_validate_json(row["data"]) if row else None

    def _delete_memory(self, thread_id: str) -> None:
        self._db.execute("DELETE FROM working_memory WHERE thread_id=?", (thread_id,))

    def _recover(self) -> None:
        # 崩溃前可能已经改了文件，不能把旧任务悄悄再跑一次。
        rows = self._db.execute(
            "SELECT id FROM tasks WHERE status IN "
            "('QUEUED','RUNNING','CANCELLATION_REQUESTED','PAUSE_REQUESTED','PAUSED','WAITING_FOR_INPUT')",
        ).fetchall()
        for row in rows:
            identifier = failure("task_recovered_after_interruption", RuntimeError(),
                                 level="warn", task_id=row["id"])
            self._update_task(
                row["id"],
                {
                    "status": "FAILED",
                    "completed_at": now(),
                    "question": None,
                    "error": public_error(
                        identifier, "上次运行被中断，记录已保留，任务不会自动重跑"
                    ),
                },
            )

    def close(self) -> None:
        with self._lock:
            self._db.close()


class SQLiteWorkingMemoryStore:
    """复用原来的工作记忆接口，但保存到本机磁盘，不设置过期时间。"""

    def __init__(self, storage: StoragePort) -> None:
        self.storage = storage

    async def load(self, thread_id: str) -> WorkingMemory | None:
        return await self.storage.call("load_memory", thread_id)

    async def save(self, memory: WorkingMemory, *, ttl_seconds: int | None = None) -> None:
        await self.storage.call("save_memory", memory.model_copy(deep=True))

    async def delete(self, thread_id: str) -> None:
        await self.storage.call("delete_memory", thread_id)
