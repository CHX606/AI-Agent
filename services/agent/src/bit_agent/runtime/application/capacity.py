"""任务真正工作时占一个名额；等人回答时把名额让给别的工作区。"""

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Self

from bit_agent.runtime.domain.errors import InteractionError


class WorkspaceReservations:
    """包含同一文件的父子目录互斥，互不重叠的目录仍可并行。"""

    def __init__(self) -> None:
        self._condition = asyncio.Condition()
        self._active: dict[object, Path] = {}
        self._waiting: list[tuple[object, Path]] = []

    @staticmethod
    def _overlaps(left: Path, right: Path) -> bool:
        return left.is_relative_to(right) or right.is_relative_to(left)

    @asynccontextmanager
    async def hold(self, root: Path, *, wait: bool = True):
        root = Path(os.path.normcase(str(root.resolve())))
        ticket = object()
        async with self._condition:
            self._waiting.append((ticket, root))

            def available() -> bool:
                if any(self._overlaps(root, active) for active in self._active.values()):
                    return False
                # 重叠目录按提交顺序等待，其他目录不必陪着排队。
                for previous, pending in self._waiting:
                    if previous is ticket:
                        return True
                    if self._overlaps(root, pending):
                        return False
                return False

            try:
                if not wait and not available():
                    raise InteractionError("这个工作区还有任务在执行或暂停，请结束后再审阅")
                await self._condition.wait_for(available)
                self._active[ticket] = root
            finally:
                self._waiting.remove((ticket, root))
                self._condition.notify_all()
        try:
            yield
        finally:
            async with self._condition:
                self._active.pop(ticket)
                self._condition.notify_all()


class ExecutionSlot:
    def __init__(self, semaphore: asyncio.Semaphore) -> None:
        self.semaphore = semaphore
        self.owned = False

    async def acquire(self) -> None:
        if not self.owned:
            await self.semaphore.acquire()
            self.owned = True

    def release(self) -> None:
        if self.owned:
            self.owned = False
            self.semaphore.release()

    async def __aenter__(self) -> Self:
        await self.acquire()
        return self

    async def __aexit__(self, *args: object) -> None:
        self.release()
