import shutil
from pathlib import Path

import pytest
from bit_agent.sandbox import SandboxResult
from bit_agent.tools import apply_patch, run_tests
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolStatus
from bit_agent.tools.run_tests import TestRunner

PROJECT_ROOT = Path(__file__).resolve().parents[4]
FIXTURE_ROOT = PROJECT_ROOT / "evals" / "fixtures" / "calculator_bug"

FIX_PATCH = """\
diff --git a/src/calculator.py b/src/calculator.py
--- a/src/calculator.py
+++ b/src/calculator.py
@@ -1,2 +1,2 @@
 def add(left: int, right: int) -> int:
-    return left - right
+    return left + right
"""


class CalculatorSandbox:
    async def run(
        self,
        workspace_root: Path,
        command: list[str],
        timeout_seconds: float,
    ) -> SandboxResult:
        del command, timeout_seconds
        source = (workspace_root / "src" / "calculator.py").read_text(encoding="utf-8")
        if "return left + right" in source:
            return SandboxResult("fake-container", 0, stdout="1 passed")
        return SandboxResult("fake-container", 1, stdout="1 failed")


@pytest.mark.asyncio
async def test_failure_patch_success_workflow(tmp_path: Path) -> None:
    workspace = tmp_path / "calculator_bug"
    shutil.copytree(FIXTURE_ROOT, workspace)
    test_file = workspace / "tests" / "test_calculator.py"
    original_test = test_file.read_bytes()
    runner = TestRunner(CalculatorSandbox())

    failing_result = await run_tests(
        ToolContext(workspace, "call_before", timeout_seconds=10),
        "tests/test_calculator.py",
        runner=runner,
    )

    assert failing_result.status is ToolStatus.ERROR
    assert failing_result.error and failing_result.error.code == "TESTS_FAILED"
    assert failing_result.output["exit_code"] == 1

    patch_result = await apply_patch(
        ToolContext(workspace, "call_patch", timeout_seconds=10),
        FIX_PATCH,
    )

    assert patch_result.status is ToolStatus.SUCCESS
    assert patch_result.metadata.affected_paths == ["src/calculator.py"]

    passing_result = await run_tests(
        ToolContext(workspace, "call_after", timeout_seconds=10),
        "tests/test_calculator.py",
        runner=runner,
    )

    assert passing_result.status is ToolStatus.SUCCESS
    assert passing_result.output["exit_code"] == 0
    assert (workspace / "src" / "calculator.py").read_text(encoding="utf-8") == (
        "def add(left: int, right: int) -> int:\n    return left + right\n"
    )
    assert test_file.read_bytes() == original_test
