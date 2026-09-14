"""受控目录遍历工具。"""

import asyncio
from pathlib import Path
from time import perf_counter

from bit_agent.security.paths import PathSecurityError
from bit_agent.tools.common import (
    BLOCKED_PARTS,
    path_error_result,
    result,
    safe_path,
)
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolResult, ToolStatus


async def list_files(
    context: ToolContext,
    path: str = "",
    *,
    max_depth: int = 2,
    include_hidden: bool = False,
) -> ToolResult:
    started = perf_counter()

    if (
        not isinstance(max_depth, int)
        or isinstance(max_depth, bool)
        or not 0 <= max_depth <= context.max_depth
    ):
        return result(
            context,
            "list_files",
            started,
            status=ToolStatus.ERROR,
            code="INVALID_ARGUMENT",
            message=f"max_depth 必须在 0 到 {context.max_depth} 之间",
            retryable=True,
        )

    try:
        target, relative = safe_path(context, path)
    except PathSecurityError as exc:
        return path_error_result(context, "list_files", started, exc)

    if not target.exists():
        return result(
            context,
            "list_files",
            started,
            status=ToolStatus.ERROR,
            code="FILE_NOT_FOUND",
            message=f"目录不存在：{path}",
            retryable=True,
        )

    if not target.is_dir():
        return result(
            context,
            "list_files",
            started,
            status=ToolStatus.ERROR,
            code="INVALID_ARGUMENT",
            message=f"目标不是目录：{path}",
            retryable=True,
        )

    def walk() -> tuple[list[str], bool]:
        def is_unsafe_link(item: Path) -> bool:
            return item.is_symlink() or item.is_junction()

        entries: list[str] = []
        stack: list[tuple[Path, int]] = [(target, 0)]

        while stack:
            directory, depth = stack.pop()

            children = sorted(
                directory.iterdir(),
                key=lambda item: (
                    is_unsafe_link(item) or not item.is_dir(),
                    item.name.casefold(),
                ),
            )

            next_directories: list[Path] = []

            for child in children:
                name = child.name

                if (
                    is_unsafe_link(child)
                    or name.casefold() in BLOCKED_PARTS
                    or (not include_hidden and name.startswith("."))
                ):
                    continue

                child_relative = child.relative_to(context.workspace_root).as_posix()

                entries.append(child_relative + ("/" if child.is_dir() else ""))

                if len(entries) > context.max_results:
                    return entries[: context.max_results], True

                if child.is_dir() and depth < max_depth:
                    next_directories.append(child)

            stack.extend((item, depth + 1) for item in reversed(next_directories))

        return entries, False

    entries, exceeded = await asyncio.to_thread(walk)

    output = "\n".join(entries)
    output_bytes = output.encode("utf-8")
    output_exceeded = len(output_bytes) > context.max_output_bytes

    if output_exceeded:
        output = output_bytes[: context.max_output_bytes].decode(
            "utf-8",
            errors="ignore",
        )

    if exceeded or output_exceeded:
        code = "RESULT_LIMIT_EXCEEDED" if exceeded else "OUTPUT_LIMIT_EXCEEDED"

        message = (
            f"结果超过 {context.max_results} 项"
            if exceeded
            else f"输出超过 {context.max_output_bytes} 字节"
        )

        return result(
            context,
            "list_files",
            started,
            status=ToolStatus.ERROR,
            output=output,
            code=code,
            message=message,
            retryable=True,
            truncated=True,
            paths=[relative] if relative else [],
        )

    return result(
        context,
        "list_files",
        started,
        status=ToolStatus.SUCCESS,
        output=output,
        paths=[relative] if relative else [],
    )
