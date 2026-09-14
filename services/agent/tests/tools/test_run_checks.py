import shutil
import subprocess
from pathlib import Path

import pytest
from bit_agent.sandbox import SandboxResult
from bit_agent.tools import run_checks
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolStatus
from bit_agent.tools.run_checks import CHECK_COMMANDS, CheckKind, CheckRunner


def docker_image_ready() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        completed = subprocess.run(
            ["docker", "image", "inspect", "bit-agent-python-sandbox:0.1.0"],
            check=False,
            capture_output=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0


DOCKER_IMAGE_READY = docker_image_ready()


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


@pytest.mark.parametrize("check", list(CheckKind))
@pytest.mark.asyncio
async def test_runs_only_the_fixed_command_for_each_check(
    tmp_path: Path,
    check: CheckKind,
) -> None:
    runner, sandbox = fake_runner(SandboxResult("container-1", 0, stdout="ok"))

    outcome = await run_checks(
        ToolContext(tmp_path, "call-1", timeout_seconds=20),
        check.value,
        [""],
        runner=runner,
    )

    assert outcome.status is ToolStatus.SUCCESS
    assert outcome.output["check"] == check.value
    assert sandbox.calls == [(tmp_path.resolve(), [*CHECK_COMMANDS[check], "."], 20)]


@pytest.mark.asyncio
async def test_rejects_unknown_check_without_starting_sandbox(tmp_path: Path) -> None:
    outcome = await run_checks(ToolContext(tmp_path, "call-1"), "shell", [""])

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "INVALID_ARGUMENT"


@pytest.mark.asyncio
async def test_reports_failed_check(tmp_path: Path) -> None:
    runner, _ = fake_runner(SandboxResult("container-1", 1, stdout="F401 unused import"))

    outcome = await run_checks(
        ToolContext(tmp_path, "call-1"),
        "lint",
        [""],
        runner=runner,
    )

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "CHECK_FAILED"
    assert outcome.output["exit_code"] == 1


@pytest.mark.asyncio
async def test_reports_timeout_and_sandbox_failure(tmp_path: Path) -> None:
    timeout_runner, _ = fake_runner(SandboxResult("container-1", 137, timed_out=True))
    timed_out = await run_checks(
        ToolContext(tmp_path, "call-1", timeout_seconds=5),
        "typecheck",
        [""],
        runner=timeout_runner,
    )
    assert timed_out.status is ToolStatus.TIMEOUT
    assert timed_out.error and timed_out.error.code == "PROCESS_TIMEOUT"

    failed_runner, _ = fake_runner(SandboxResult(None, None, start_error="docker missing"))
    unavailable = await run_checks(
        ToolContext(tmp_path, "call-2"),
        "build",
        [""],
        runner=failed_runner,
    )
    assert unavailable.status is ToolStatus.ERROR
    assert unavailable.error and unavailable.error.code == "SANDBOX_UNAVAILABLE"


@pytest.mark.skipif(not DOCKER_IMAGE_READY, reason="Docker 或 Bit Agent 沙箱镜像不可用")
@pytest.mark.asyncio
async def test_real_docker_runs_python_quality_and_build_checks(tmp_path: Path) -> None:
    source = tmp_path / "src" / "demo_package"
    source.mkdir(parents=True)
    module = source / "__init__.py"
    module.write_text(
        "def add(left: int, right: int) -> int:\n    return left + right\n",
        encoding="utf-8",
    )
    (tmp_path / "pyproject.toml").write_text(
        "[build-system]\n"
        'requires = ["setuptools>=75"]\n'
        'build-backend = "setuptools.build_meta"\n\n'
        "[project]\n"
        'name = "demo-package"\n'
        'version = "0.1.0"\n'
        'requires-python = ">=3.12"\n',
        encoding="utf-8",
    )
    context = ToolContext(tmp_path, "real-check", timeout_seconds=30)

    for check, paths in (
        ("lint", ["src"]),
        ("format", ["src"]),
        ("typecheck", ["src"]),
        ("build", [""]),
    ):
        outcome = await run_checks(context, check, paths)
        assert outcome.status is ToolStatus.SUCCESS, outcome.model_dump_json(indent=2)

    module.write_text("import os\n\ndef broken() -> None:\n    pass\n", encoding="utf-8")
    failed_lint = await run_checks(context, "lint", ["src"])
    assert failed_lint.status is ToolStatus.ERROR
    assert failed_lint.error and failed_lint.error.code == "CHECK_FAILED"
    assert "F401" in str(failed_lint.output)
