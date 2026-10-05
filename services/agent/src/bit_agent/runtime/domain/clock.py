"""给用户输入打上严格递增的接收时间，恢复时才能还原真实先后顺序。"""

import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta


def _utc_now() -> datetime:
    return datetime.now(UTC)


class AcceptedClock:
    """Windows 上 datetime.now() 约 15 毫秒才前进一次，连续两次输入可能拿到同一时间。

    同一进程内遇到相同或倒退的时间时向后推一微秒，回答、补充和改目标共用这一个时钟。
    """

    def __init__(self, now: Callable[[], datetime] = _utc_now) -> None:
        self.now = now
        self._lock = threading.Lock()
        self._last: datetime | None = None

    def __call__(self) -> str:
        with self._lock:
            current = self.now()
            if self._last is not None and current <= self._last:
                current = self._last + timedelta(microseconds=1)
            self._last = current
            return current.isoformat(timespec="microseconds")


accepted_at = AcceptedClock()
