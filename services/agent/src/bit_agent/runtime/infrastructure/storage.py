"""本地 SQLite 存储的事务、线程及事件等待入口。"""

import asyncio
import threading
from pathlib import Path
from typing import Any

from bit_agent.memory.models import WorkingMemory
from bit_agent.observability.diagnostics import failure, safe_fields
from bit_agent.runtime.application.ports import StoragePort
from bit_agent.runtime.infrastructure.storage_context import ContextRecords
from bit_agent.runtime.infrastructure.storage_database import (
    default_data_directory as default_data_directory,
)
from bit_agent.runtime.infrastructure.storage_database import (
    now as now,
)
from bit_agent.runtime.infrastructure.storage_database import (
    open_database,
)
from bit_agent.runtime.infrastructure.storage_events import StorageEvents
from bit_agent.runtime.infrastructure.storage_migration import LegacySessions
from bit_agent.runtime.infrastructure.storage_rewind import TurnCheckpoints
from bit_agent.runtime.infrastructure.storage_sessions import SessionRecords
from bit_agent.runtime.infrastructure.storage_tasks import TaskRecords


class LocalStorage(
    TaskRecords, SessionRecords, ContextRecords, StorageEvents, LegacySessions, TurnCheckpoints
):
    """所有操作共享同一连接，由调用入口保证一次事务。"""

    def __init__(self, directory: Path) -> None:
        self.directory = directory.resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.event_version = 0
        self._event_waiters: list[asyncio.Future[None]] = []
        self._db = open_database(self.directory)

    async def call(self, operation: str, *args: Any) -> Any:
        # 磁盘读写放到后台线程，避免保存记录时卡住取消任务、接收消息等操作。
        result = await asyncio.to_thread(self._call, operation, args)
        if operation == "event":
            self.event_version += 1
            waiters, self._event_waiters = self._event_waiters, []
            for waiter in waiters:
                if not waiter.done():
                    waiter.set_result(None)
        return result

    async def wait_for_events(self, since: int, timeout: float) -> None:
        """等到 event_version 离开 since（有新事件写入）或超时。"""
        if self.event_version != since or timeout <= 0:
            return
        waiter = asyncio.get_running_loop().create_future()
        self._event_waiters.append(waiter)
        try:
            await asyncio.wait_for(waiter, timeout)
        except TimeoutError:
            pass
        finally:
            if waiter in self._event_waiters:
                self._event_waiters.remove(waiter)

    def _call(self, operation: str, args: tuple[Any, ...]) -> Any:
        try:
            with self._lock, self._db:
                return getattr(self, f"_{operation}")(*args)
        except Exception as exc:
            identifiers = safe_fields(args[0]) if args and isinstance(args[0], dict) else {}
            failure(
                "storage_failed",
                exc,
                operation=operation,
                **{k: v for k, v in identifiers.items() if k in {"task_id", "session_id"}},
            )
            raise

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
