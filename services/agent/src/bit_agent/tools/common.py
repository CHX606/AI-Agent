"""工具实现共享的计时、结果和路径辅助函数。"""

from pathlib import Path
from time import perf_counter
from typing import Any

from bit_agent.security.paths import (
    PROTECTED_DIRECTORIES,
    PathSecurityError,
    resolve_workspace_path,
)
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus

BLOCKED_PARTS = PROTECTED_DIRECTORIES


def elapsed_ms(started: float) -> int:
    return max(0, round((perf_counter() - started) * 1000))


def truncate_text(text: str, max_bytes: int) -> tuple[str, bool]:
    """按 UTF-8 字节限制保留文本开头和结尾。"""
    encoded = text.encode("utf-8")
    if max_bytes <= 0:
        return "", bool(encoded)
    if len(encoded) <= max_bytes:
        return text, False

    marker = b"\n... output truncated ...\n"
    if max_bytes <= len(marker):
        return encoded[:max_bytes].decode("utf-8", errors="ignore"), True

    remaining = max_bytes - len(marker)
    head_size = remaining // 2
    tail_size = remaining - head_size
    head = encoded[:head_size].decode("utf-8", errors="ignore")
    tail = encoded[-tail_size:].decode("utf-8", errors="ignore")
    return head + marker.decode() + tail, True


def result(
    context: ToolContext,
    tool_name: str,
    started: float,
    *,
    status: ToolStatus,
    output: Any | None = None,
    code: str | None = None,
    message: str | None = None,
    retryable: bool = False,
    truncated: bool = False,
    paths: list[str] | None = None,
) -> ToolResult:
    error = None
    if status is not ToolStatus.SUCCESS:
        error = ToolError(
            code=code or "INTERNAL_ERROR", message=message or "工具执行失败", retryable=retryable
        )
    return ToolResult(
        tool_call_id=context.tool_call_id,
        tool_name=tool_name,
        status=status,
        output=output,
        error=error,
        metadata=ToolMetadata(
            duration_ms=elapsed_ms(started), truncated=truncated, affected_paths=paths or []
        ),
    )


def path_error_result(
    context: ToolContext,
    tool_name: str,
    started: float,
    error: PathSecurityError,
) -> ToolResult:
    """把路径异常转换为统一工具结果。"""
    invalid_argument = error.code == "INVALID_ARGUMENT"
    return result(
        context,
        tool_name,
        started,
        status=ToolStatus.ERROR if invalid_argument else ToolStatus.REJECTED,
        code=error.code,
        message=str(error),
        retryable=invalid_argument,
    )


def safe_path(context: ToolContext, raw_path: str, *, allow_root: bool = True) -> tuple[Path, str]:
    """通过统一安全模块解析工作区路径，并返回规范化相对路径。"""
    target = resolve_workspace_path(
        context.workspace_root,
        raw_path,
        allow_root=allow_root,
    )
    relative = target.relative_to(context.workspace_root).as_posix()
    return target, relative
