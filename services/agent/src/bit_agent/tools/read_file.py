"""受控文本文件读取工具。"""

import asyncio
from time import perf_counter

from bit_agent.security.paths import PathSecurityError
from bit_agent.tools.common import path_error_result, result, safe_path
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolResult, ToolStatus


async def read_file(
    context: ToolContext, path: str, *, start_line: int = 1, end_line: int | None = None
) -> ToolResult:
    started = perf_counter()
    if end_line is None:
        end_line = start_line + context.max_read_lines - 1
    valid_ints = all(
        isinstance(value, int) and not isinstance(value, bool) for value in (start_line, end_line)
    )
    if (
        not valid_ints
        or start_line < 1
        or end_line < start_line
        or end_line - start_line + 1 > context.max_read_lines
    ):
        return result(
            context,
            "read_file",
            started,
            status=ToolStatus.ERROR,
            code="INVALID_ARGUMENT",
            message=f"行号必须有效，且单次最多读取 {context.max_read_lines} 行",
            retryable=True,
        )
    try:
        target, relative = safe_path(context, path, allow_root=False)
    except PathSecurityError as exc:
        return path_error_result(context, "read_file", started, exc)
    if not target.exists():
        return result(
            context,
            "read_file",
            started,
            status=ToolStatus.ERROR,
            code="FILE_NOT_FOUND",
            message=f"文件不存在：{path}",
            retryable=True,
        )
    if not target.is_file():
        return result(
            context,
            "read_file",
            started,
            status=ToolStatus.ERROR,
            code="INVALID_ARGUMENT",
            message=f"目标不是普通文件：{path}",
            retryable=True,
        )

    def read() -> tuple[str | None, bool]:
        data = target.read_bytes()
        if b"\x00" in data:
            return None, False
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return None, False
        selected = text.splitlines()[start_line - 1 : end_line]
        rendered = "\n".join(
            f"{number:>6} | {line}" for number, line in enumerate(selected, start_line)
        )
        encoded = rendered.encode("utf-8")
        if len(encoded) <= context.max_output_bytes:
            return rendered, False
        shortened = encoded[: context.max_output_bytes].decode("utf-8", errors="ignore")
        return shortened, True

    output, truncated = await asyncio.to_thread(read)
    if output is None:
        return result(
            context,
            "read_file",
            started,
            status=ToolStatus.ERROR,
            code="NOT_A_TEXT_FILE",
            message=f"文件不是 UTF-8 文本：{path}",
            paths=[relative],
        )
    if truncated:
        return result(
            context,
            "read_file",
            started,
            status=ToolStatus.ERROR,
            output=output,
            code="OUTPUT_LIMIT_EXCEEDED",
            message=f"输出超过 {context.max_output_bytes} 字节",
            retryable=True,
            truncated=True,
            paths=[relative],
        )
    return result(
        context, "read_file", started, status=ToolStatus.SUCCESS, output=output, paths=[relative]
    )
