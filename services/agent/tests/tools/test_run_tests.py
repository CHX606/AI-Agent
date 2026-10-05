import importlib
import sys
from pathlib import Path

import pytest
from bit_agent.sandbox import SandboxResult
from bit_agent.tools import run_tests
from bit_agent.tools.command_runtime import python_executable
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolStatus
from bit_agent.tools.run_tests import TestRunner


class FakeSandbox:
    def __init__(self, outcome: SandboxResult) -> None:
        self.outcome = outcome
        self.calls: list[tuple[Path, list[str], float]] = []

    async def run(
        self,
        workspace_root: Path,
        command: list[str],
        timeout_seconds: float,
    ) -> SandboxResult:
        self.calls.append((workspace_root, command, timeout_seconds))
        return self.outcome


def write_test(workspace: Path, name: str, content: str = "def test_it():\n    pass\n") -> Path:
    tests_directory = workspace / "tests"
    tests_directory.mkdir(exist_ok=True)
    target = tests_directory / name
    target.write_text(content, encoding="utf-8")
    return target


def fake_runner(outcome: SandboxResult) -> tuple[TestRunner, FakeSandbox]:
    sandbox = FakeSandbox(outcome)
    return TestRunner(sandbox), sandbox


@pytest.mark.asyncio
async def test_runs_fixed_pytest_command_for_passing_test(tmp_path: Path) -> None:
    write_test(tmp_path, "test_pass.py")
    runner, sandbox = fake_runner(SandboxResult(0, stdout="1 passed"))

    outcome = await run_tests(
        ToolContext(tmp_path, "call_1", timeout_seconds=10),
        "tests/test_pass.py",
        runner=runner,
    )

    assert outcome.status is ToolStatus.SUCCESS
    assert outcome.output["target"] == "tests/test_pass.py"
    assert outcome.output["exit_code"] == 0
    assert outcome.output["timed_out"] is False
    assert sandbox.calls == [
        (
            tmp_path.resolve(),
            [sys.executable, "-m", "pytest", "-q", "--", "tests/test_pass.py"],
            10,
        )
    ]


@pytest.mark.asyncio
async def test_reports_failing_test(tmp_path: Path) -> None:
    write_test(tmp_path, "test_fail.py")
    runner, _ = fake_runner(SandboxResult(1, stdout="1 failed"))

    outcome = await run_tests(
        ToolContext(tmp_path, "call_1", timeout_seconds=10),
        "tests/test_fail.py",
        runner=runner,
    )

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "TESTS_FAILED"
    assert outcome.output["exit_code"] == 1


@pytest.mark.asyncio
async def test_missing_test_target_is_error(tmp_path: Path) -> None:
    outcome = await run_tests(ToolContext(tmp_path, "call_1"), "tests/test_missing.py")

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "FILE_NOT_FOUND"


@pytest.mark.asyncio
async def test_test_execution_timeout(tmp_path: Path) -> None:
    write_test(tmp_path, "test_slow.py")
    runner, _ = fake_runner(SandboxResult(137, stdout="started", timed_out=True))

    outcome = await run_tests(
        ToolContext(tmp_path, "call_1", timeout_seconds=1),
        "tests/test_slow.py",
        timeout_seconds=0.2,
        runner=runner,
    )

    assert outcome.status is ToolStatus.TIMEOUT
    assert outcome.error and outcome.error.code == "PROCESS_TIMEOUT"
    assert outcome.output["timed_out"] is True


@pytest.mark.asyncio
async def test_sandbox_truncation_is_preserved(tmp_path: Path) -> None:
    write_test(tmp_path, "test_output.py")
    runner, _ = fake_runner(
        SandboxResult(
            1,
            stdout="HEAD\n... output truncated ...\nTAIL",
            truncated=True,
        )
    )

    outcome = await run_tests(
        ToolContext(tmp_path, "call_1", max_output_bytes=500),
        "tests/test_output.py",
        runner=runner,
    )

    assert outcome.status is ToolStatus.ERROR
    assert outcome.metadata.truncated
    assert outcome.output["stdout"].startswith("HEAD")
    assert outcome.output["stdout"].endswith("TAIL")


@pytest.mark.asyncio
async def test_rejects_non_test_target(tmp_path: Path) -> None:
    source_directory = tmp_path / "src"
    source_directory.mkdir()
    (source_directory / "main.py").write_text("print('hello')\n", encoding="utf-8")

    outcome = await run_tests(ToolContext(tmp_path, "call_1"), "src/main.py")

    assert outcome.status is ToolStatus.REJECTED
    assert outcome.error and outcome.error.code == "TARGET_NOT_ALLOWED"


@pytest.mark.asyncio
async def test_rejects_timeout_above_worker_limit(tmp_path: Path) -> None:
    write_test(tmp_path, "test_pass.py")

    outcome = await run_tests(
        ToolContext(tmp_path, "call_1", timeout_seconds=5),
        "tests/test_pass.py",
        timeout_seconds=10,
    )

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "INVALID_ARGUMENT"


@pytest.mark.asyncio
async def test_no_collected_tests_is_reported(tmp_path: Path) -> None:
    (tmp_path / "tests").mkdir()
    runner, _ = fake_runner(SandboxResult(5))

    outcome = await run_tests(
        ToolContext(tmp_path, "call_1", timeout_seconds=10),
        "tests",
        runner=runner,
    )

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "NO_TESTS_COLLECTED"
    assert outcome.output["exit_code"] == 5


@pytest.mark.asyncio
async def test_reports_sandbox_start_error(tmp_path: Path) -> None:
    write_test(tmp_path, "test_pass.py")
    runner, _ = fake_runner(SandboxResult(None, start_error="OS sandbox executable was not found"))

    outcome = await run_tests(
        ToolContext(tmp_path, "call_1"),
        "tests/test_pass.py",
        runner=runner,
    )

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "SANDBOX_UNAVAILABLE"
    assert outcome.error.retryable


@pytest.mark.parametrize("relative", [".venv/Scripts/python.exe", ".venv/bin/python"])
def test_selects_workspace_python(tmp_path: Path, relative: str) -> None:
    executable = tmp_path / relative
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"")

    assert python_executable(tmp_path) == str(executable)


def test_python_selection_prefers_windows_file_and_ignores_directories(tmp_path: Path) -> None:
    windows = tmp_path / ".venv" / "Scripts" / "python.exe"
    posix = tmp_path / ".venv" / "bin" / "python"
    windows.mkdir(parents=True)
    posix.parent.mkdir(parents=True)
    posix.write_bytes(b"")
    assert python_executable(tmp_path) == str(posix)
    windows.rmdir()
    windows.write_bytes(b"")
    assert python_executable(tmp_path) == str(windows)


def test_python_selection_falls_back_to_current_process(tmp_path: Path) -> None:
    assert python_executable(tmp_path) == sys.executable


@pytest.mark.asyncio
async def test_runner_uses_workspace_virtual_environment(tmp_path: Path) -> None:
    executable = tmp_path / ".venv" / "Scripts" / "python.exe"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"")
    write_test(tmp_path, "test_pass.py")
    runner, sandbox = fake_runner(SandboxResult(0))

    outcome = await run_tests(ToolContext(tmp_path, "venv"), "tests", runner=runner)

    assert outcome.status is ToolStatus.SUCCESS
    assert sandbox.calls[0][1][0] == str(executable)


@pytest.mark.asyncio
async def test_default_runner_passes_context_to_os_sandbox(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_test(tmp_path, "test_pass.py")
    sandbox = FakeSandbox(SandboxResult(0, stdout="1 passed"))
    arguments: dict[str, object] = {}

    def factory(**kwargs: object) -> FakeSandbox:
        arguments.update(kwargs)
        return sandbox

    module = importlib.import_module("bit_agent.tools.run_tests")
    monkeypatch.setattr(module, "OSSandbox", factory)
    context = ToolContext(tmp_path, "default-run", task_id="task-42", max_output_bytes=512)

    outcome = await run_tests(context, "tests")

    assert outcome.status is ToolStatus.SUCCESS
    assert arguments == {
        "task_id": "task-42",
        "tool_call_id": "default-run",
        "max_output_bytes": 512,
    }
    assert sandbox.calls[0][1] == [sys.executable, "-m", "pytest", "-q", "--", "tests"]


@pytest.mark.parametrize("timeout", [True, 0, -1, "1", float("nan"), float("inf")])
@pytest.mark.asyncio
async def test_invalid_timeout_never_runs_process(tmp_path: Path, timeout: object) -> None:
    write_test(tmp_path, "test_pass.py")
    runner, sandbox = fake_runner(SandboxResult(0))

    outcome = await run_tests(
        ToolContext(tmp_path, "invalid-timeout"), "tests", timeout_seconds=timeout, runner=runner
    )

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "INVALID_ARGUMENT"
    assert sandbox.calls == []


@pytest.mark.parametrize("target", ["../tests", ".venv/test_hidden.py", "C:/outside/test.py"])
@pytest.mark.asyncio
async def test_rejected_path_never_runs_process(tmp_path: Path, target: str) -> None:
    runner, sandbox = fake_runner(SandboxResult(0))

    outcome = await run_tests(ToolContext(tmp_path, "bad-path"), target, runner=runner)

    assert outcome.status is ToolStatus.REJECTED
    assert sandbox.calls == []
