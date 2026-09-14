"""受控命令执行器的公共接口。"""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True, slots=True)
class SandboxResult:
    """一次沙箱命令执行的完整结果。"""

    container_id: str | None
    exit_code: int | None
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = 0
    timed_out: bool = False
    cleanup_confirmed: bool | None = None
    truncated: bool = False
    start_error: str | None = None


class Sandbox(Protocol):
    """Worker 可以注入的受控执行器。"""

    async def run(
        self,
        workspace_root: Path,
        command: list[str],
        timeout_seconds: float,
    ) -> SandboxResult:
        """在隔离环境中运行一个由 Worker 构造的命令。"""
