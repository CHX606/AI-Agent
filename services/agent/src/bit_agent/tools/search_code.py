"""通过参数化 ripgrep 子进程执行受控代码搜索。"""

import asyncio
from time import perf_counter

from bit_agent.security.paths import (
    PRIVATE_KEY_NAMES,
    PRIVATE_KEY_SUFFIXES,
    PROTECTED_DIRECTORIES,
    PathSecurityError,
)
from bit_agent.tools.common import path_error_result, result, safe_path
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolResult, ToolStatus


async def search_code(
    context: ToolContext,
    query: str,
    path: str = "",
    *,
    glob: str | None = None,
    max_results: int = 50,
) -> ToolResult:
    started = perf_counter()
    if not isinstance(query, str) or not query or "\x00" in query:
        return result(
            context,
            "search_code",
            started,
            status=ToolStatus.ERROR,
            code="INVALID_ARGUMENT",
            message="query 必须是非空字符串",
            retryable=True,
        )
    if (
        not isinstance(max_results, int)
        or isinstance(max_results, bool)
        or not 1 <= max_results <= context.max_results
    ):
        return result(
            context,
            "search_code",
            started,
            status=ToolStatus.ERROR,
            code="INVALID_ARGUMENT",
            message=f"max_results 必须在 1 到 {context.max_results} 之间",
            retryable=True,
        )
    if glob is not None and (not isinstance(glob, str) or not glob or "\x00" in glob):
        return result(
            context,
            "search_code",
            started,
            status=ToolStatus.ERROR,
            code="INVALID_ARGUMENT",
            message="glob 必须是非空字符串",
            retryable=True,
        )
    try:
        target, relative = safe_path(context, path)
    except PathSecurityError as exc:
        return path_error_result(context, "search_code", started, exc)
    if not target.exists():
        return result(
            context,
            "search_code",
            started,
            status=ToolStatus.ERROR,
            code="FILE_NOT_FOUND",
            message=f"路径不存在：{path}",
            retryable=True,
        )

    args = [
        "rg",
        "--line-number",
        "--column",
        "--color",
        "never",
        "--no-heading",
        "--max-count",
        str(max_results + 1),
    ]
    if glob is not None:
        args.extend(["--glob", glob])
    # 用户过滤条件不能重新包含受保护文件；后面的排除规则优先，且不区分大小写。
    protected_globs = [
        ".env", ".env.*", *sorted(PRIVATE_KEY_NAMES),
        *(f"*{suffix}" for suffix in sorted(PRIVATE_KEY_SUFFIXES)),
        *(f"**/{name}/**" for name in sorted(PROTECTED_DIRECTORIES)),
    ]
    for pattern in protected_globs:
        args.extend(["--iglob", f"!{pattern}"])
    args.extend(["--", query, str(target)])
    try:
        process = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(
            process.communicate(), timeout=context.timeout_seconds
        )
    except TimeoutError:
        if "process" in locals():
            process.kill()
            await process.communicate()
        return result(
            context,
            "search_code",
            started,
            status=ToolStatus.TIMEOUT,
            code="PROCESS_TIMEOUT",
            message=f"搜索超过 {context.timeout_seconds} 秒",
            retryable=True,
        )
    except FileNotFoundError:
        return result(
            context,
            "search_code",
            started,
            status=ToolStatus.ERROR,
            code="INTERNAL_ERROR",
            message="系统未安装 ripgrep",
        )

    stderr_text = stderr.decode("utf-8", errors="replace").strip()
    if process.returncode not in (0, 1):
        return result(
            context,
            "search_code",
            started,
            status=ToolStatus.ERROR,
            code="INTERNAL_ERROR",
            message=stderr_text or f"rg 退出码：{process.returncode}",
            retryable=True,
        )
    raw_lines = stdout.decode("utf-8", errors="replace").splitlines()
    exceeded = len(raw_lines) > max_results
    raw_lines = raw_lines[:max_results]
    root_prefix = str(context.workspace_root).replace("\\", "/") + "/"
    output = "\n".join(line.replace("\\", "/").replace(root_prefix, "", 1) for line in raw_lines)
    encoded = output.encode("utf-8")
    byte_exceeded = len(encoded) > context.max_output_bytes
    if byte_exceeded:
        output = encoded[: context.max_output_bytes].decode("utf-8", errors="ignore")
    if exceeded or byte_exceeded:
        code = "RESULT_LIMIT_EXCEEDED" if exceeded else "OUTPUT_LIMIT_EXCEEDED"
        limits = []
        if exceeded:
            limits.append(f"匹配超过设定的 {max_results} 条")
        if byte_exceeded:
            limits.append(f"输出超过 {context.max_output_bytes} 字节")
        guidance = (
            "搜索结果不完整（已截断）：" + "；".join(limits) + "。"
            "当前 output 仅为部分结果，不能据此认定其他位置没有匹配。"
            "请使用更具体的关键词 query、缩小搜索路径 path，或使用 glob 过滤文件。"
        )
        if exceeded and not byte_exceeded and max_results < context.max_results:
            guidance += f"也可适当提高 max_results（最多 {context.max_results}）。"
        if byte_exceeded:
            guidance += "单纯提高 max_results 不能突破输出字节上限。"
        guidance += "调整参数后再试；原样重复搜索不会自动返回下一批结果。"
        return result(
            context,
            "search_code",
            started,
            status=ToolStatus.ERROR,
            output=output,
            code=code,
            message=guidance,
            retryable=True,
            truncated=True,
            paths=[relative] if relative else [],
        )
    return result(
        context,
        "search_code",
        started,
        status=ToolStatus.SUCCESS,
        output=output,
        paths=[relative] if relative else [],
    )
