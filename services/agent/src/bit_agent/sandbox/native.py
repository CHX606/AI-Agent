"""Run commands with Anthropic's pinned official Windows OS sandbox SDK."""

import asyncio
import json
import secrets
import shutil
import sys
from pathlib import Path
from time import perf_counter
from weakref import WeakKeyDictionary

from bit_agent.security.paths import resolve_workspace_path

from .base import SandboxResult
from .configuration import VERSION, environment, runtime_paths, validate_locations
from .process import execute

START_ERROR = "BIT_AGENT_SANDBOX_START_ERROR"
CLEANUP_ERROR = "BIT_AGENT_SANDBOX_CLEANUP_ERROR:"
# 官方 SDK 的文件授权挂在同一个沙箱账户上，重叠运行能互相读写对方的工作区。
# 进程内排队，超时从轮到本次运行时才开始计算；跨进程由执行器的命名管道锁兜底。
_RUN_LOCKS: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock] = WeakKeyDictionary()


def _run_lock() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    lock = _RUN_LOCKS.get(loop)
    if lock is None:
        lock = _RUN_LOCKS[loop] = asyncio.Lock()
    return lock


def command_arguments(command: list[str]) -> list[str]:
    program = Path(command[0])
    if not program.is_absolute():
        found = shutil.which(command[0])
        if not found:
            raise ValueError(f"找不到项目命令：{command[0]}，请准备项目工具链")
        program = Path(found)
    resolved = [str(program.resolve(strict=True)), *command[1:]]
    if program.suffix.lower() in {".cmd", ".bat"} and any(
        any(char in arg for char in '&|<>^()%!"\r\n') for arg in resolved
    ):
        raise ValueError("批处理命令的参数包含不支持的 Shell 字符，拒绝执行")
    return resolved


def arguments(root: Path, command: list[str], nonce: str) -> list[str]:
    node, broker, _ = runtime_paths()
    resolved = command_arguments(command)
    payload = dict(
        workspace=str(root),
        command=resolved,
        readPaths=list(
            dict.fromkeys(
                [str(Path(sys.base_prefix)), str(Path(sys.prefix)), str(Path(resolved[0]).parent)]
            )
        ),
    )
    return [str(node), str(broker), json.dumps(payload, ensure_ascii=True), nonce]


def broker_error(stderr: str, nonce: str) -> str | None:
    """只认带本次随机串的执行器标记；被测命令自己打印的同名文字不算。"""
    marker = f"{START_ERROR}[{nonce}]:"
    index = stderr.rfind(marker)
    if index < 0:
        return None
    return stderr[index + len(marker) :].strip() or "沙箱执行器没有说明原因"


async def sandbox_status() -> dict:
    try:
        node, broker, _ = runtime_paths()
        result = await execute(
            [str(node), str(broker), "--status"], broker.parent, environment(), 10, 8192
        )
        status = json.loads(result["stdout"])
        if result["exit_code"] != 0 or status.get("version") != VERSION:
            raise RuntimeError("官方沙箱版本或状态检查不正确")
        return status
    except (OSError, ValueError, RuntimeError, KeyError) as exc:
        return dict(available=False, message=str(exc), backend="anthropic-windows", version=VERSION)


def _validate_command(command: list[str], timeout: float) -> None:
    if not command or any(not isinstance(arg, str) or "\0" in arg for arg in command):
        raise ValueError("command 必须是非空字符串列表")
    if not command[0]:
        raise ValueError("命令执行文件不能为空")
    if isinstance(timeout, bool) or not isinstance(timeout, int | float) or timeout <= 0:
        raise ValueError("timeout_seconds 必须为正数")


def _elapsed(started: float) -> int:
    return round((perf_counter() - started) * 1000)


class OSSandbox:
    def __init__(
        self, *, task_id: str, tool_call_id: str, max_output_bytes: int = 64 * 1024
    ) -> None:
        if not task_id.strip() or not tool_call_id.strip() or max_output_bytes <= 0:
            raise ValueError("task_id、tool_call_id 和输出上限必须有效")
        self.max_output_bytes = max_output_bytes

    async def run(
        self, workspace_root: Path, command: list[str], timeout_seconds: float
    ) -> SandboxResult:
        _validate_command(command, timeout_seconds)
        root = resolve_workspace_path(workspace_root, "", allow_root=True)
        async with _run_lock():
            return await self._run_exclusive(root, command, float(timeout_seconds))

    async def _run_exclusive(self, root: Path, command: list[str], timeout: float) -> SandboxResult:
        started, nonce = perf_counter(), secrets.token_hex(16)
        try:
            validate_locations(root, *runtime_paths())
            result = await execute(
                arguments(root, command, nonce),
                root,
                environment(),
                timeout,
                self.max_output_bytes,
            )
        except (OSError, ValueError, RuntimeError) as exc:
            return SandboxResult(None, start_error=str(exc), duration_ms=_elapsed(started))
        error = broker_error(result["stderr"], nonce)
        if result["timed_out"] and error and CLEANUP_ERROR in error:
            result["cleanup_confirmed"] = False
        return SandboxResult(**result, start_error=error, duration_ms=_elapsed(started))
