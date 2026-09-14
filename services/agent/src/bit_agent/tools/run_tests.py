"""通过固定 pytest 命令在受控沙箱中运行测试。"""

from pathlib import Path
from time import perf_counter

from bit_agent.sandbox import DockerSandbox, Sandbox, SandboxResult
from bit_agent.security.paths import PathSecurityError, resolve_workspace_path
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
            ["python", "-m", "pytest", "-q", "--", target],
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


def _test_output(target: str, outcome: SandboxResult) -> dict[str, object]:
    return {
        "target": target,
        "exit_code": outcome.exit_code,
        "stdout": outcome.stdout,
        "stderr": outcome.stderr,
        "timed_out": outcome.timed_out,
    }


async def run_tests(
    context: ToolContext,
    target: str,
    *,
    timeout_seconds: float | None = None,
    runner: TestRunner | None = None,
) -> ToolResult:
    """异步运行工作区内允许的 pytest 测试目标。"""
    started = perf_counter()

    if timeout_seconds is None:
        effective_timeout = context.timeout_seconds
    elif (
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
            message=f"timeout_seconds 必须大于 0 且不超过 {context.timeout_seconds}",
            retryable=True,
        )
    else:
        effective_timeout = float(timeout_seconds)

    try:
        resolved_target = resolve_workspace_path(context.workspace_root, target)
    except PathSecurityError as exc:
        return path_error_result(context, "run_tests", started, exc)

    relative_target = resolved_target.relative_to(context.workspace_root).as_posix()
    if not resolved_target.exists():
        return result(
            context,
            "run_tests",
            started,
            status=ToolStatus.ERROR,
            code="FILE_NOT_FOUND",
            message=f"测试目标不存在：{target}",
            retryable=True,
        )

    if not resolved_target.is_file() and not resolved_target.is_dir():
        return result(
            context,
            "run_tests",
            started,
            status=ToolStatus.ERROR,
            code="INVALID_ARGUMENT",
            message=f"测试目标不是普通文件或目录：{target}",
            retryable=True,
        )

    if not _is_allowed_test_target(resolved_target, context.workspace_root):
        return result(
            context,
            "run_tests",
            started,
            status=ToolStatus.REJECTED,
            code="TARGET_NOT_ALLOWED",
            message="只允许运行测试目录或 Python 测试文件",
        )

    if runner is None:
        runner = TestRunner(
            DockerSandbox(
                task_id=context.task_id,
                tool_call_id=context.tool_call_id,
                max_output_bytes=context.max_output_bytes,
            )
        )
    outcome = await runner.run(
        context.workspace_root,
        relative_target,
        effective_timeout,
    )
    if outcome.start_error is not None:
        return result(
            context,
            "run_tests",
            started,
            status=ToolStatus.ERROR,
            code="SANDBOX_UNAVAILABLE",
            message=f"无法启动测试沙箱：{outcome.start_error}",
            retryable=True,
            paths=[relative_target],
        )

    output = _test_output(relative_target, outcome)
    if outcome.timed_out:
        return result(
            context,
            "run_tests",
            started,
            status=ToolStatus.TIMEOUT,
            output=output,
            code="PROCESS_TIMEOUT",
            message=f"测试执行超过 {effective_timeout} 秒",
            retryable=True,
            truncated=outcome.truncated,
            paths=[relative_target],
        )

    if outcome.exit_code == 0:
        return result(
            context,
            "run_tests",
            started,
            status=ToolStatus.SUCCESS,
            output=output,
            truncated=outcome.truncated,
            paths=[relative_target],
        )

    if outcome.exit_code == 1:
        code = "TESTS_FAILED"
        message = "测试执行完成，但存在失败用例"
        retryable = False
    elif outcome.exit_code == 5:
        code = "NO_TESTS_COLLECTED"
        message = "pytest 没有发现测试"
        retryable = True
    else:
        code = "TEST_EXECUTION_ERROR"
        message = f"pytest 执行错误，退出码：{outcome.exit_code}"
        retryable = True

    return result(
        context,
        "run_tests",
        started,
        status=ToolStatus.ERROR,
        output=output,
        code=code,
        message=message,
        retryable=retryable,
        truncated=outcome.truncated,
        paths=[relative_target],
    )
