"""会话列表、历史、标题和删除操作。"""

import json
import shutil
from typing import Any


class SessionRecords:
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

    def _list_sessions(self, limit: int = 200, offset: int = 0, query: str = "") -> dict[str, Any]:
        if query:
            # 标题，或者任何一轮的要求、回答里包含关键词（任务记录以原文 JSON 保存）。
            pattern = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            pattern += "%"
            rows = self._db.execute(
                "SELECT id FROM sessions WHERE title LIKE ? ESCAPE '\\' OR id IN "
                "(SELECT session_id FROM tasks WHERE data LIKE ? ESCAPE '\\') "
                "ORDER BY updated_at DESC, id LIMIT ? OFFSET ?",
                (pattern, pattern, limit, offset),
            ).fetchall()
        else:
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
        # 页面恢复消息文字和图片，不重复传输完整工具日志。
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
                    # 停止的轮次界面已经显示“已停止”，不再把停止说明当成回答再显示一遍。
                    "final_answer": result.get("final_answer")
                    or (task.get("error") if task["status"] != "CANCELLED" else None)
                    or "",
                    "intent_updates": self._task_inputs(task),
                    **({"images": task["images"]} if task.get("images") else {}),
                    **({"attachments": task["attachments"]} if task.get("attachments") else {}),
                }
            )
        return {
            "session": session,
            "turns": turns,
            "rewindable_task_id": self._rewindable_task(session_id),
        }

    def _set_mode(self, session_id: str, mode: str) -> dict[str, Any] | None:
        self._db.execute("UPDATE sessions SET mode=? WHERE id=?", (mode, session_id))
        return self._session(session_id)

    def _rename_session(self, session_id: str, title: str) -> dict[str, Any] | None:
        self._db.execute("UPDATE sessions SET title=? WHERE id=?", (title, session_id))
        return self._session(session_id)

    def _delete_session(self, session_id: str) -> list[str]:
        """删除对话和它所有轮次的记录，返回任务编号，供随后删除对应的大文件目录。"""
        task_ids = [
            row["id"]
            for row in self._db.execute("SELECT id FROM tasks WHERE session_id=?", (session_id,))
        ]
        for table in ("events", "transcript", "user_answers"):
            self._db.executemany(
                f"DELETE FROM {table} WHERE task_id=?", [(task_id,) for task_id in task_ids]
            )
        self._db.execute("DELETE FROM tasks WHERE session_id=?", (session_id,))
        self._db.execute("DELETE FROM context_state WHERE session_id=?", (session_id,))
        self._db.execute("DELETE FROM working_memory WHERE thread_id=?", (session_id,))
        self._db.execute("DELETE FROM turn_checkpoints WHERE session_id=?", (session_id,))
        self._db.execute("DELETE FROM sessions WHERE id=?", (session_id,))
        return task_ids

    def _remove_artifacts(self, task_ids: list[str]) -> None:
        """在数据库记录删除并提交之后调用；目录名只接受任务编号，不会越出 artifacts。"""
        root = (self.directory / "artifacts").resolve()
        for task_id in task_ids:
            target = (root / task_id).resolve()
            if target.parent == root and target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
