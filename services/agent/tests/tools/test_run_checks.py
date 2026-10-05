import importlib
import importlib.util
import os
import sys
from pathlib import Path

import pytest
from bit_agent.sandbox import SandboxResult
from bit_agent.tools import run_checks
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolStatus
from bit_agent.tools.run_checks import CheckRunner


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


def fake_runner(outcome: SandboxResult) -> tuple[CheckRunner, FakeSandbox]:
    sandbox = FakeSandbox(outcome)
    return CheckRunner(sandbox), sandbox


@pytest.mark.parametrize(
    ("check", "expected"),
    [
        ("lint", ["-m", "ruff", "check", "--no-cache", "--", "."]),
        ("format", ["-m", "ruff", "format", "--check", "--no-cache", "--", "."]),
        ("typecheck", ["-m", "mypy", f"--cache-dir={os.devnull}", "--", "."]),
        ("build", ["-m", "build", "--", "."]),
    ],
)
@pytest.mark.asyncio
async def test_runs_only_the_fixed_command_for_each_check(
    tmp_path: Path, check: str, expected: list[str]
) -> None:
    runner, sandbox = fake_runner(SandboxResult(0, stdout="ok"))

    outcome = await run_checks(
        ToolContext(tmp_path, "call-1", timeout_seconds=20), check, [""], runner=runner
    )

    assert outcome.status is ToolStatus.SUCCESS
    assert outcome.output["check"] == check
    root, command, timeout = sandbox.calls[0]
    assert (root, timeout) == (tmp_path.resolve(), 20)
    assert command[0] == sys.executable
    assert command[1:] == expected


@pytest.mark.asyncio
async def test_rejects_unknown_check_without_starting_sandbox(tmp_path: Path) -> None:
    outcome = await run_checks(ToolContext(tmp_path, "call-1"), "shell", [""])

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "INVALID_ARGUMENT"


@pytest.mark.asyncio
async def test_reports_failed_check(tmp_path: Path) -> None:
    runner, _ = fake_runner(SandboxResult(1, stdout="F401 unused import"))

    outcome = await run_checks(ToolContext(tmp_path, "call-1"), "lint", [""], runner=runner)

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "CHECK_FAILED"
    assert outcome.output["exit_code"] == 1
    assert "outcome" not in outcome.output


@pytest.mark.parametrize(
    ("check", "stderr"),
    [
        ("build", "python: No module named build"),
        ("build", "ModuleNotFoundError: No module named 'build'"),
        ("build", "No module named build.__main__; 'build' cannot be directly executed"),
        ("lint", "python: No module named ruff"),
        ("format", 'ModuleNotFoundError: No module named "ruff"'),
        ("typecheck", "python: No module named mypy"),
    ],
)
@pytest.mark.asyncio
async def test_missing_check_module_is_explicitly_unverified(
    tmp_path: Path, check: str, stderr: str
) -> None:
    runner, _ = fake_runner(SandboxResult(1, stderr=stderr))

    outcome = await run_checks(ToolContext(tmp_path, "missing-module"), check, [""], runner=runner)

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "CHECK_UNAVAILABLE"
    assert outcome.output["outcome"] == "UNVERIFIED"
    assert outcome.output["stderr"] == stderr


@pytest.mark.asyncio
async def test_project_missing_import_still_reports_failed_check(tmp_path: Path) -> None:
    runner, _ = fake_runner(SandboxResult(1, stderr="No module named build_backend"))

    outcome = await run_checks(ToolContext(tmp_path, "failed"), "build", [""], runner=runner)

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "CHECK_FAILED"
    assert "outcome" not in outcome.output


@pytest.mark.asyncio
async def test_reports_timeout_and_sandbox_failure(tmp_path: Path) -> None:
    timeout_runner, _ = fake_runner(SandboxResult(137, timed_out=True))
    timed_out = await run_checks(
        ToolContext(tmp_path, "call-1", timeout_seconds=5), "typecheck", [""], runner=timeout_runner
    )
    assert timed_out.status is ToolStatus.TIMEOUT
    assert timed_out.error and timed_out.error.code == "PROCESS_TIMEOUT"

    failed_runner, _ = fake_runner(SandboxResult(None, start_error="OS sandbox unavailable"))
    unavailable = await run_checks(
        ToolContext(tmp_path, "call-2"), "build", [""], runner=failed_runner
    )
    assert unavailable.status is ToolStatus.ERROR
    assert unavailable.error and unavailable.error.code == "SANDBOX_UNAVAILABLE"


@pytest.mark.asyncio
async def test_default_runner_passes_context_to_os_sandbox(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sandbox = FakeSandbox(SandboxResult(0))
    arguments: dict[str, object] = {}

    def factory(**kwargs: object) -> FakeSandbox:
        arguments.update(kwargs)
        return sandbox

    monkeypatch.setattr(importlib.import_module("bit_agent.tools.run_checks"), "OSSandbox", factory)
    context = ToolContext(tmp_path, "default-check", task_id="task-42", max_output_bytes=512)

    outcome = await run_checks(context, "lint", [""])

    assert outcome.status is ToolStatus.SUCCESS
    assert arguments == {
        "task_id": "task-42",
        "tool_call_id": "default-check",
        "max_output_bytes": 512,
    }
    assert sandbox.calls[0][1][0] == sys.executable


@pytest.mark.asyncio
async def test_runner_uses_virtual_environment_and_separates_option_like_paths(
    tmp_path: Path,
) -> None:
    executable = tmp_path / ".venv" / "Scripts" / "python.exe"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"")
    (tmp_path / "--help").mkdir()
    runner, sandbox = fake_runner(SandboxResult(0))

    outcome = await run_checks(
        ToolContext(tmp_path, "venv"), "lint", ["--help", "--help"], runner=runner
    )

    assert outcome.status is ToolStatus.SUCCESS
    assert sandbox.calls[0][1] == [
        str(executable),
        "-m",
        "ruff",
        "check",
        "--no-cache",
        "--",
        "--help",
    ]
    assert outcome.output["paths"] == ["--help"]


@pytest.mark.parametrize("paths", [[], [" "], [1], [""] * 101])
@pytest.mark.asyncio
async def test_invalid_paths_never_runs_process(tmp_path: Path, paths: list[object]) -> None:
    runner, sandbox = fake_runner(SandboxResult(0))

    outcome = await run_checks(ToolContext(tmp_path, "invalid"), "lint", paths, runner=runner)

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "INVALID_ARGUMENT"
    assert sandbox.calls == []


@pytest.mark.parametrize("path", ["../outside", ".venv/private.py", "C:/outside/main.py"])
@pytest.mark.asyncio
async def test_unsafe_paths_never_runs_process(tmp_path: Path, path: str) -> None:
    runner, sandbox = fake_runner(SandboxResult(0))

    outcome = await run_checks(ToolContext(tmp_path, "invalid"), "lint", [path], runner=runner)

    assert outcome.status is ToolStatus.REJECTED
    assert sandbox.calls == []


@pytest.mark.parametrize("timeout", [True, 0, -1, 6, "1", float("nan"), float("inf")])
@pytest.mark.asyncio
async def test_invalid_timeout_never_runs_process(tmp_path: Path, timeout: object) -> None:
    runner, sandbox = fake_runner(SandboxResult(0))

    outcome = await run_checks(
        ToolContext(tmp_path, "invalid"), "lint", [""], timeout_seconds=timeout, runner=runner
    )

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "INVALID_ARGUMENT"
    assert sandbox.calls == []


@pytest.mark.asyncio
async def test_build_rejects_multiple_or_file_targets(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "file.py").write_text("", encoding="utf-8")
    runner, sandbox = fake_runner(SandboxResult(0))

    for paths in (["", "src"], ["file.py"]):
        outcome = await run_checks(
            ToolContext(tmp_path, "build-target"), "build", paths, runner=runner
        )
        assert outcome.status is ToolStatus.ERROR
        assert outcome.error and outcome.error.code == "INVALID_ARGUMENT"
    assert sandbox.calls == []


@pytest.mark.asyncio
async def test_real_os_runs_python_quality_checks(tmp_path: Path) -> None:
    source = tmp_path / "src" / "demo_package"
    source.mkdir(parents=True)
    module = source / "__init__.py"
    module.write_text(
        "def add(left: int, right: int) -> int:\n    return left + right\n", encoding="utf-8"
    )
    context = ToolContext(tmp_path, "real-check", timeout_seconds=30)

    for check in ("lint", "format"):
        outcome = await run_checks(context, check, ["src"])
        assert outcome.status is ToolStatus.SUCCESS, outcome.model_dump_json(indent=2)

    module.write_text("import os\n\ndef broken() -> None:\n    pass\n", encoding="utf-8")
    failed_lint = await run_checks(context, "lint", ["src"])
    assert failed_lint.status is ToolStatus.ERROR
    assert failed_lint.error and failed_lint.error.code == "CHECK_FAILED"
    assert "F401" in str(failed_lint.output)


@pytest.mark.parametrize("check", ["build", "typecheck"])
@pytest.mark.asyncio
async def test_real_missing_module_is_unverified(tmp_path: Path, check: str) -> None:
    module = {"build": "build", "typecheck": "mypy"}[check]
    if importlib.util.find_spec(module) is not None:
        pytest.skip(f"当前环境已安装 {module}，缺失模块路径由独立回归覆盖")

    outcome = await run_checks(
        ToolContext(tmp_path, "missing-real", timeout_seconds=30), check, [""]
    )

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "CHECK_UNAVAILABLE"
    assert outcome.output["outcome"] == "UNVERIFIED"


@pytest.mark.parametrize(
    "message",
    [
        "ERROR Backend 'setuptools.build_meta' is not available. BackendUnavailable",
        "ERROR Missing dependencies: setuptools>=75",
        "ModuleNotFoundError: No module named 'setuptools'",
    ],
)
async def test_missing_build_backend_is_unverified_not_success(tmp_path: Path, message: str):
    runner, _ = fake_runner(SandboxResult(1, stderr=message))
    outcome = await run_checks(
        ToolContext(tmp_path, "missing-backend"), "build", [""], runner=runner
    )
    assert outcome.status is ToolStatus.ERROR
    assert outcome.error.code == "CHECK_UNAVAILABLE"
    assert outcome.output["outcome"] == "UNVERIFIED"
