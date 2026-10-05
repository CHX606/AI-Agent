"""通过固定 pytest 命令在受控 OS 沙箱中运行测试。"""

from pathlib import Path
from time import perf_counter

from bit_agent.sandbox import OSSandbox, Sandbox, SandboxResult
from bit_agent.security.paths import PathSecurityError, resolve_workspace_path
from bit_agent.tools.command_runtime import python_executable
from bit_agent.tools.common import path_error_result, result
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolResult, ToolStatus


class TestRunner:
    """只允许构造固定 pytest 命令的测试执行器。"""

    __test__ = False

    def __init__(self, sandbox: Sandbox) -> None:
        self.sandbox = sandbox

    async def run(
        self,
        workspace_root: Path,
        target: str,
        timeout_seconds: float,
    ) -> SandboxResult:
        return await self.sandbox.run(
            workspace_root,
            [python_executable(workspace_root), "-m", "pytest", "-q", "--", target],
            timeout_seconds,
        )


def _is_allowed_test_target(target: Path, workspace_root: Path) -> bool:
    relative = target.relative_to(workspace_root)
    lowered_parts = [part.casefold() for part in relative.parts]
    inside_test_directory = any(part in {"test", "tests"} for part in lowered_parts[:-1])
    if target.is_dir():
        return any(part in {"test", "tests"} for part in lowered_parts)
    name = target.name.casefold()
    has_test_filename = name.startswith("test_") or name.endswith("_test.py")
    return target.suffix.casefold() == ".py" and (inside_test_directory or has_test_filename)


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
        return result(
            context,
            "run_tests",
            started,
            status=ToolStatus.ERROR,
            code="INVALID_ARGUMENT",
            retryable=True,
            message=f"timeout_seconds 必须大于 0 且不超过 {context.timeout_seconds}",
        )
    return float(timeout_seconds)


def _test_target(context: ToolContext, target: str, started: float) -> str | ToolResult:
    try:
        resolved = resolve_workspace_path(context.workspace_root, target)
    except PathSecurityError as exc:
        return path_error_result(context, "run_tests", started, exc)
    if not resolved.exists():
        return result(
            context,
            "run_tests",
            started,
            status=ToolStatus.ERROR,
            code="FILE_NOT_FOUND",
            message=f"测试目标不存在：{target}",
            retryable=True,
        )
    if not resolved.is_file() and not resolved.is_dir():
        return result(
            context,
            "run_tests",
            started,
            status=ToolStatus.ERROR,
            code="INVALID_ARGUMENT",
            message=f"测试目标不是普通文件或目录：{target}",
            retryable=True,
        )
    if not _is_allowed_test_target(resolved, context.workspace_root):
        return result(
            context,
            "run_tests",
            started,
            status=ToolStatus.REJECTED,
            code="TARGET_NOT_ALLOWED",
            message="只允许运行测试目录或 Python 测试文件",
        )
    return resolved.relative_to(context.workspace_root).as_posix()


def _test_output(target: str, outcome: SandboxResult) -> dict[str, object]:
    return {
        "target": target,
        "exit_code": outcome.exit_code,
        "stdout": outcome.stdout,
        "stderr": outcome.stderr,
        "timed_out": outcome.timed_out,
    }


def _test_status(
    outcome: SandboxResult, timeout_seconds: float
) -> tuple[ToolStatus, str | None, str | None, bool]:
    if outcome.timed_out:
        return ToolStatus.TIMEOUT, "PROCESS_TIMEOUT", f"测试执行超过 {timeout_seconds} 秒", True
    if outcome.exit_code == 0:
        return ToolStatus.SUCCESS, None, None, False
    if outcome.exit_code == 1:
        return ToolStatus.ERROR, "TESTS_FAILED", "测试执行完成，但存在失败用例", False
    if outcome.exit_code == 5:
        return ToolStatus.ERROR, "NO_TESTS_COLLECTED", "pytest 没有发现测试", True
    return (
        ToolStatus.ERROR,
        "TEST_EXECUTION_ERROR",
        f"pytest 执行错误，退出码：{outcome.exit_code}",
        True,
    )


def _test_result(
    context: ToolContext,
    started: float,
    target: str,
    timeout_seconds: float,
    outcome: SandboxResult,
) -> ToolResult:
    if outcome.start_error is not None:
        return result(
            context,
            "run_tests",
            started,
            status=ToolStatus.ERROR,
            code="SANDBOX_UNAVAILABLE",
            message=f"无法启动测试沙箱：{outcome.start_error}",
            retryable=True,
            paths=[target],
        )
    status, code, message, retryable = _test_status(outcome, timeout_seconds)
    return result(
        context,
        "run_tests",
        started,
        status=status,
        output=_test_output(target, outcome),
        code=code,
        message=message,
        retryable=retryable,
        truncated=outcome.truncated,
        paths=[target],
    )


async def run_tests(
    context: ToolContext,
    target: str,
    *,
    timeout_seconds: float | None = None,
    runner: TestRunner | None = None,
) -> ToolResult:
    """异步运行工作区内允许的 pytest 测试目标。"""
    started = perf_counter()
    effective_timeout = _timeout(context, timeout_seconds, started)
    if isinstance(effective_timeout, ToolResult):
        return effective_timeout
    relative_target = _test_target(context, target, started)
    if isinstance(relative_target, ToolResult):
        return relative_target
    if runner is None:
        runner = TestRunner(
            OSSandbox(
                task_id=context.task_id,
                tool_call_id=context.tool_call_id,
                max_output_bytes=context.max_output_bytes,
            )
        )
    outcome = await runner.run(context.workspace_root, relative_target, effective_timeout)
    return _test_result(context, started, relative_target, effective_timeout, outcome)
