import json
import shutil
import subprocess
from pathlib import Path

import pytest
from bit_agent.agent.result import AgentRunResult, AgentRunStatus
from bit_agent.evals import EvalCase, EvalRunner, path_matches, snapshot_workspace
from bit_agent.sandbox import DEFAULT_IMAGE
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus

FIXTURE = Path(__file__).resolve().parents[1] / "evals" / "fixtures" / "bug_fix_calculator"


def docker_image_ready() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        completed = subprocess.run(
            ["docker", "image", "inspect", DEFAULT_IMAGE],
            check=False,
            capture_output=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0


DOCKER_IMAGE_READY = docker_image_ready()


def bug_fix_case() -> EvalCase:
    return EvalCase(
        name="bug-demo",
        prompt="项目存在一个功能错误，请自行定位、修复并运行测试。",
        fixture_path=FIXTURE,
        test_target="tests",
        allowed_paths=["calculator.py"],
        immutable_paths=["tests/**", "README.md", ".git/**", ".env", ".env.*"],
    )


def successful_agent_result(changed_files: list[str]) -> AgentRunResult:
    return AgentRunResult(
        status=AgentRunStatus.COMPLETED,
        final_answer="错误已修复，测试通过。",
        rounds=2,
        changed_files=changed_files,
        tests_passed=True,
    )


def verification_result(status: ToolStatus = ToolStatus.SUCCESS) -> ToolResult:
    return ToolResult(
        tool_call_id="independent-verification",
        tool_name="run_tests",
        status=status,
        output={"exit_code": 0} if status is ToolStatus.SUCCESS else {"exit_code": 1},
        error=None
        if status is ToolStatus.SUCCESS
        else ToolError(code="TESTS_FAILED", message="独立测试失败", retryable=False),
        metadata=ToolMetadata(duration_ms=1, affected_paths=["tests"]),
    )


def fix_calculator(workspace_root: Path) -> None:
    calculator = workspace_root / "calculator.py"
    calculator.write_text(
        calculator.read_text(encoding="utf-8").replace(
            "return left - right",
            "return left + right",
            1,
        ),
        encoding="utf-8",
    )


def test_root_cache_patterns_are_ignored(tmp_path: Path) -> None:
    (tmp_path / "kept.py").write_text("value = 1\n", encoding="utf-8")
    cache = tmp_path / "__pycache__"
    cache.mkdir()
    (cache / "kept.cpython-312.pyc").write_bytes(b"cache")

    snapshot = snapshot_workspace(tmp_path, ["**/__pycache__/**", "**/*.pyc"])

    assert list(snapshot) == ["kept.py"]
    assert path_matches("__pycache__/file.pyc", ["**/__pycache__/**"])


@pytest.mark.asyncio
async def test_eval_runner_uses_copy_verifies_changes_saves_artifacts_and_cleans(
    tmp_path: Path,
) -> None:
    workspaces: list[Path] = []

    async def fake_agent(
        prompt: str,
        *,
        workspace_root: Path,
    ) -> AgentRunResult:
        assert prompt == bug_fix_case().prompt
        workspaces.append(workspace_root)
        fix_calculator(workspace_root)
        return successful_agent_result(["calculator.py"])

    async def fake_verifier(context: ToolContext, target: str) -> ToolResult:
        assert target == "tests"
        assert "return left + right" in (context.workspace_root / "calculator.py").read_text(
            encoding="utf-8"
        )
        return verification_result()

    results_root = tmp_path / "results"
    temporary_root = tmp_path / "temporary"
    runner = EvalRunner(
        results_root,
        agent_runner=fake_agent,
        verification_runner=fake_verifier,
        temporary_root=temporary_root,
    )

    result = await runner.run(bug_fix_case())

    assert result.passed is True
    assert result.file_changes.added == []
    assert result.file_changes.modified == ["calculator.py"]
    assert result.file_changes.deleted == []
    assert result.violations == []
    assert "return left - right" in (FIXTURE / "calculator.py").read_text(encoding="utf-8")
    assert workspaces and not workspaces[0].exists()
    assert list(temporary_root.iterdir()) == []

    artifact_names = {path.name for path in result.artifact_directory.iterdir()}
    assert artifact_names == {
        "agent_result.json",
        "changes.diff",
        "result.json",
        "verification.json",
    }
    saved_result = json.loads((result.artifact_directory / "result.json").read_text("utf-8"))
    assert saved_result["passed"] is True
    diff = (result.artifact_directory / "changes.diff").read_text(encoding="utf-8")
    assert "-    return left - right" in diff
    assert "+    return left + right" in diff


@pytest.mark.asyncio
async def test_eval_runner_rejects_changes_to_immutable_test_files(tmp_path: Path) -> None:
    async def fake_agent(
        prompt: str,
        *,
        workspace_root: Path,
    ) -> AgentRunResult:
        fix_calculator(workspace_root)
        test_file = workspace_root / "tests" / "test_calculator.py"
        test_file.write_text(
            test_file.read_text(encoding="utf-8") + "\n# 被 Agent 修改\n",
            encoding="utf-8",
        )
        return successful_agent_result(["calculator.py", "tests/test_calculator.py"])

    async def fake_verifier(context: ToolContext, target: str) -> ToolResult:
        return verification_result()

    runner = EvalRunner(
        tmp_path / "results",
        agent_runner=fake_agent,
        verification_runner=fake_verifier,
    )

    result = await runner.run(bug_fix_case())

    assert result.passed is False
    assert result.file_changes.modified == ["calculator.py", "tests/test_calculator.py"]
    assert any(
        violation.code == "IMMUTABLE_PATH_CHANGED"
        and violation.path == "tests/test_calculator.py"
        for violation in result.violations
    )


@pytest.mark.asyncio
async def test_eval_runner_does_not_trust_agent_test_claim(tmp_path: Path) -> None:
    async def fake_agent(
        prompt: str,
        *,
        workspace_root: Path,
    ) -> AgentRunResult:
        fix_calculator(workspace_root)
        return successful_agent_result(["calculator.py"])

    async def failing_verifier(context: ToolContext, target: str) -> ToolResult:
        return verification_result(ToolStatus.ERROR)

    runner = EvalRunner(
        tmp_path / "results",
        agent_runner=fake_agent,
        verification_runner=failing_verifier,
    )

    result = await runner.run(bug_fix_case())

    assert result.agent_result.tests_passed is True
    assert result.verification_result.status is ToolStatus.ERROR
    assert result.passed is False
    assert any(
        violation.code == "INDEPENDENT_TESTS_FAILED" for violation in result.violations
    )


@pytest.mark.skipif(not DOCKER_IMAGE_READY, reason="Docker 或 Bit Agent 沙箱镜像不可用")
@pytest.mark.asyncio
async def test_eval_runner_performs_real_independent_docker_verification(tmp_path: Path) -> None:
    async def fake_agent(
        prompt: str,
        *,
        workspace_root: Path,
    ) -> AgentRunResult:
        fix_calculator(workspace_root)
        return successful_agent_result(["calculator.py"])

    runner = EvalRunner(tmp_path / "results", agent_runner=fake_agent)

    result = await runner.run(bug_fix_case())

    assert result.passed is True
    assert result.verification_result.status is ToolStatus.SUCCESS
    assert result.verification_result.output["exit_code"] == 0
