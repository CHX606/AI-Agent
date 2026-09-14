"""在受控沙箱中运行固定的代码质量与构建检查。"""

from enum import StrEnum
from pathlib import Path
from time import perf_counter

from bit_agent.sandbox import DockerSandbox, Sandbox, SandboxResult
from bit_agent.security.paths import PathSecurityError, resolve_workspace_path
from bit_agent.tools.common import path_error_result, result
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolResult, ToolStatus


class CheckKind(StrEnum):
    """允许模型选择的检查类型。"""

    LINT = "lint"
    FORMAT = "format"
    TYPECHECK = "typecheck"
    BUILD = "build"


CHECK_COMMANDS: dict[CheckKind, list[str]] = {
    # Windows 文件通过 bind mount 进入 Linux 时没有可靠的可执行位，忽略 EXE002。
    CheckKind.LINT: [
        "python",
        "-m",
        "ruff",
        "check",
        "--no-cache",
        "--ignore",
        "EXE002",
    ],
    CheckKind.FORMAT: [
        "python",
        "-m",
        "ruff",
        "format",
        "--check",
        "--no-cache",
    ],
    CheckKind.TYPECHECK: ["python", "-m", "mypy", "--cache-dir=/tmp/mypy-cache"],
    CheckKind.BUILD: ["python", "/opt/bit-agent/run_python_build.py"],
}


class CheckRunner:
    """只执行框架预先定义的检查命令。"""

    __test__ = False

    def __init__(self, sandbox: Sandbox) -> None:
        self.sandbox = sandbox

    async def run(
        self,
        workspace_root: Path,
        check: CheckKind,
        paths: list[str],
        timeout_seconds: float,
    ) -> SandboxResult:
        return await self.sandbox.run(
            workspace_root,
            [*CHECK_COMMANDS[check], *paths],
            timeout_seconds,
        )


def _check_output(
    check: CheckKind,
    paths: list[str],
    outcome: SandboxResult,
) -> dict[str, object]:
    return {
        "check": check.value,
        "paths": paths,
        "exit_code": outcome.exit_code,
        "stdout": outcome.stdout,
        "stderr": outcome.stderr,
        "timed_out": outcome.timed_out,
    }


async def run_checks(
    context: ToolContext,
    check: str,
    paths: list[str],
    *,
    timeout_seconds: float | None = None,
    runner: CheckRunner | None = None,
) -> ToolResult:
    """在整个工作区运行一个白名单检查。"""
    started = perf_counter()
    try:
        check_kind = CheckKind(check)
    except ValueError:
        allowed = ", ".join(item.value for item in CheckKind)
        return result(
            context,
            "run_checks",
            started,
            status=ToolStatus.ERROR,
            code="INVALID_ARGUMENT",
            message=f"未知检查类型：{check}；允许值：{allowed}",
            retryable=True,
        )

    if (
        not isinstance(paths, list)
        or not paths
        or len(paths) > 100
        or any(
            not isinstance(path, str) or (path != "" and not path.strip())
            for path in paths
        )
    ):
        return result(
            context,
            "run_checks",
            started,
            status=ToolStatus.ERROR,
            code="INVALID_ARGUMENT",
            message="paths 必须包含 1 到 100 个非空相对路径",
            retryable=True,
        )

    normalized_paths: list[str] = []
    for raw_path in paths:
        try:
            resolved_path = resolve_workspace_path(
                context.workspace_root,
                raw_path,
                allow_root=True,
            )
        except PathSecurityError as exc:
            return path_error_result(context, "run_checks", started, exc)
        if not resolved_path.exists():
            return result(
                context,
                "run_checks",
                started,
                status=ToolStatus.ERROR,
                code="FILE_NOT_FOUND",
                message=f"检查目标不存在：{raw_path}",
                retryable=True,
            )
        relative_path = resolved_path.relative_to(context.workspace_root).as_posix() or "."
        if relative_path not in normalized_paths:
            normalized_paths.append(relative_path)

    if check_kind is CheckKind.BUILD and (
        len(normalized_paths) != 1
        or not resolve_workspace_path(
            context.workspace_root,
            normalized_paths[0],
            allow_root=True,
        ).is_dir()
    ):
        return result(
            context,
            "run_checks",
            started,
            status=ToolStatus.ERROR,
            code="INVALID_ARGUMENT",
            message="build 必须且只能指定一个项目目录",
            retryable=True,
        )

    if timeout_seconds is None:
        effective_timeout = context.timeout_seconds
    elif (
        not isinstance(timeout_seconds, int | float)
        or isinstance(timeout_seconds, bool)
        or not 0 < timeout_seconds <= context.timeout_seconds
    ):
        return result(
            context,
            "run_checks",
            started,
            status=ToolStatus.ERROR,
            code="INVALID_ARGUMENT",
            message=f"timeout_seconds 必须大于 0 且不超过 {context.timeout_seconds}",
            retryable=True,
        )
    else:
        effective_timeout = float(timeout_seconds)

    if runner is None:
        runner = CheckRunner(
            DockerSandbox(
                task_id=context.task_id,
                tool_call_id=context.tool_call_id,
                max_output_bytes=context.max_output_bytes,
            )
        )
    outcome = await runner.run(
        context.workspace_root,
        check_kind,
        normalized_paths,
        effective_timeout,
    )
    if outcome.start_error is not None:
        return result(
            context,
            "run_checks",
            started,
            status=ToolStatus.ERROR,
            code="SANDBOX_UNAVAILABLE",
            message=f"无法启动检查沙箱：{outcome.start_error}",
            retryable=True,
            paths=normalized_paths,
        )

    output = _check_output(check_kind, normalized_paths, outcome)
    if outcome.timed_out:
        return result(
            context,
            "run_checks",
            started,
            status=ToolStatus.TIMEOUT,
            output=output,
            code="PROCESS_TIMEOUT",
            message=f"{check_kind.value} 检查超过 {effective_timeout} 秒",
            retryable=True,
            truncated=outcome.truncated,
            paths=normalized_paths,
        )

    if outcome.exit_code == 0:
        return result(
            context,
            "run_checks",
            started,
            status=ToolStatus.SUCCESS,
            output=output,
            truncated=outcome.truncated,
            paths=normalized_paths,
        )

    return result(
        context,
        "run_checks",
        started,
        status=ToolStatus.ERROR,
        output=output,
        code="CHECK_FAILED",
        message=f"{check_kind.value} 检查失败，退出码：{outcome.exit_code}",
        truncated=outcome.truncated,
        paths=normalized_paths,
    )
