"""保存、读取事件；诊断只导出有限的元数据。"""

import json
from typing import Any

from bit_agent.observability.diagnostics import safe_fields
from bit_agent.runtime.infrastructure.storage_database import now


class StorageEvents:
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

    def _diagnostic_snapshot(self, task_id: str | None = None) -> dict[str, Any]:
        rows = self._db.execute(
            "SELECT data FROM tasks WHERE id=?"
            if task_id
            else "SELECT data FROM tasks ORDER BY created_at DESC LIMIT 50",
            (task_id,) if task_id else (),
        ).fetchall()
        tasks, events = [], []
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
            tasks.append(safe_task)
            events.extend(self._diagnostic_events(task))
        return {"tasks": tasks, "events": events}

    def _diagnostic_events(self, task: dict[str, Any]) -> list[dict[str, Any]]:
        records = self._db.execute(
            "SELECT id,event_type,data FROM events WHERE task_id=? "
            "AND event_type != 'MODEL_TEXT_DELTA' ORDER BY id DESC LIMIT 200",
            (task["task_id"],),
        ).fetchall()
        events = []
        for item in reversed(records):
            data = json.loads(item["data"])
            events.append(
                {
                    **safe_fields(data),
                    **safe_fields(data.get("payload", {})),
                    "event_id": item["id"],
                    "event": item["event_type"],
                    "task_id": task["task_id"],
                    "session_id": task["session_id"],
                }
            )
        return events
