"""在受控 OS 沙箱中运行固定的代码质量与构建检查。"""

import os
from enum import StrEnum
from pathlib import Path
from time import perf_counter

from bit_agent.sandbox import OSSandbox, Sandbox, SandboxResult
from bit_agent.security.paths import PathSecurityError, resolve_workspace_path
from bit_agent.tools.command_runtime import command_dependency_error, python_executable
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
    CheckKind.LINT: ["python", "-m", "ruff", "check", "--no-cache"],
    CheckKind.FORMAT: ["python", "-m", "ruff", "format", "--check", "--no-cache"],
    CheckKind.TYPECHECK: ["python", "-m", "mypy"],
    CheckKind.BUILD: ["python", "-m", "build"],
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
        command = [python_executable(workspace_root), *CHECK_COMMANDS[check][1:]]
        if check is CheckKind.TYPECHECK:
            # 沙箱账户写不了用户私有的临时目录；按 mypy 文档用空设备关闭缓存，
            # 也不在工作区留下 .mypy_cache。
            command.append(f"--cache-dir={os.devnull}")
        return await self.sandbox.run(workspace_root, [*command, "--", *paths], timeout_seconds)


def _argument_error(context: ToolContext, started: float, code: str, message: str) -> ToolResult:
    return result(
        context,
        "run_checks",
        started,
        status=ToolStatus.ERROR,
        code=code,
        message=message,
        retryable=True,
    )


def _check_kind(context: ToolContext, check: str, started: float) -> CheckKind | ToolResult:
    try:
        return CheckKind(check)
    except ValueError:
        allowed = ", ".join(item.value for item in CheckKind)
        return _argument_error(
            context, started, "INVALID_ARGUMENT", f"未知检查类型：{check}；允许值：{allowed}"
        )


def _check_paths(context: ToolContext, paths: list[str], started: float) -> list[str] | ToolResult:
    if (
        not isinstance(paths, list)
        or not paths
        or len(paths) > 100
        or any(not isinstance(path, str) or (path != "" and not path.strip()) for path in paths)
    ):
        return _argument_error(
            context, started, "INVALID_ARGUMENT", "paths 必须包含 1 到 100 个非空相对路径"
        )
    normalized: list[str] = []
    for raw_path in paths:
        try:
            resolved = resolve_workspace_path(context.workspace_root, raw_path, allow_root=True)
        except PathSecurityError as exc:
            return path_error_result(context, "run_checks", started, exc)
        if not resolved.exists():
            return _argument_error(
                context, started, "FILE_NOT_FOUND", f"检查目标不存在：{raw_path}"
            )
        relative = resolved.relative_to(context.workspace_root).as_posix() or "."
        if relative not in normalized:
            normalized.append(relative)
    return normalized


def _build_target_error(
    context: ToolContext, check: CheckKind, paths: list[str], started: float
) -> ToolResult | None:
    if check is not CheckKind.BUILD:
        return None
    if (
        len(paths) == 1
        and resolve_workspace_path(context.workspace_root, paths[0], allow_root=True).is_dir()
    ):
        return None
    return _argument_error(context, started, "INVALID_ARGUMENT", "build 必须且只能指定一个项目目录")


def _timeout(
    context: ToolContext, timeout_seconds: float | None, started: float
) -> float | ToolResult:
    if timeout_seconds is None:
        return context.timeout_seconds
    if (
        not isinstance(timeout_seconds, int | float)
        or isinstance(timeout_seconds, bool)
        or not 0 < timeout_seconds <= context.timeout_seconds
    ):
        return _argument_error(
            context,
            started,
            "INVALID_ARGUMENT",
            f"timeout_seconds 必须大于 0 且不超过 {context.timeout_seconds}",
        )
    return float(timeout_seconds)


def _check_output(check: CheckKind, paths: list[str], outcome: SandboxResult) -> dict[str, object]:
    return {
        "check": check.value,
        "paths": paths,
        "exit_code": outcome.exit_code,
        "stdout": outcome.stdout,
        "stderr": outcome.stderr,
        "timed_out": outcome.timed_out,
    }


def _check_status(
    check: CheckKind, outcome: SandboxResult, timeout_seconds: float
) -> tuple[ToolStatus, str | None, str | None, bool]:
    if outcome.timed_out:
        return (
            ToolStatus.TIMEOUT,
            "PROCESS_TIMEOUT",
            f"{check.value} 检查超过 {timeout_seconds} 秒",
            True,
        )
    if outcome.exit_code == 0:
        return ToolStatus.SUCCESS, None, None, False
    missing = command_dependency_error(CHECK_COMMANDS[check], outcome.stdout, outcome.stderr)
    if missing:
        return ToolStatus.ERROR, "CHECK_UNAVAILABLE", missing, False
    return (
        ToolStatus.ERROR,
        "CHECK_FAILED",
        f"{check.value} 检查失败，退出码：{outcome.exit_code}",
        False,
    )


def _check_result(
    context: ToolContext,
    started: float,
    check: CheckKind,
    paths: list[str],
    timeout_seconds: float,
    outcome: SandboxResult,
) -> ToolResult:
    if outcome.start_error is not None:
        return result(
            context,
            "run_checks",
            started,
            status=ToolStatus.ERROR,
            code="SANDBOX_UNAVAILABLE",
            message=f"无法启动检查沙箱：{outcome.start_error}",
            retryable=True,
            paths=paths,
        )
    status, code, message, retryable = _check_status(check, outcome, timeout_seconds)
    output = _check_output(check, paths, outcome)
    if code == "CHECK_UNAVAILABLE":
        output["outcome"] = "UNVERIFIED"
    return result(
        context,
        "run_checks",
        started,
        status=status,
        output=output,
        code=code,
        message=message,
        retryable=retryable,
        truncated=outcome.truncated,
        paths=paths,
    )


async def run_checks(
    context: ToolContext,
    check: str,
    paths: list[str],
    *,
    timeout_seconds: float | None = None,
    runner: CheckRunner | None = None,
) -> ToolResult:
    """在工作区运行一个白名单检查。"""
    started = perf_counter()
    check_kind = _check_kind(context, check, started)
    if isinstance(check_kind, ToolResult):
        return check_kind
    normalized_paths = _check_paths(context, paths, started)
    if isinstance(normalized_paths, ToolResult):
        return normalized_paths
    build_error = _build_target_error(context, check_kind, normalized_paths, started)
    if build_error is not None:
        return build_error
    effective_timeout = _timeout(context, timeout_seconds, started)
    if isinstance(effective_timeout, ToolResult):
        return effective_timeout
    if runner is None:
        runner = CheckRunner(
            OSSandbox(
                task_id=context.task_id,
                tool_call_id=context.tool_call_id,
                max_output_bytes=context.max_output_bytes,
            )
        )
    outcome = await runner.run(
        context.workspace_root, check_kind, normalized_paths, effective_timeout
    )
    return _check_result(context, started, check_kind, normalized_paths, effective_timeout, outcome)
