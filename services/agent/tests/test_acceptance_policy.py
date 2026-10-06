"""独立验收按执行设置决定：自动（按改动大小）、总是、关闭。"""

import json
from pathlib import Path

import pytest
from bit_agent.agent.result import ToolCallRecord
from bit_agent.agent.verification import VerificationState
from bit_agent.memory import WorkingMemory
from bit_agent.observability import InMemoryEventSink
from bit_agent.runtime.application.delegation import DelegatingToolProvider
from bit_agent.runtime.domain.acceptance_policy import (
    AUTO_MIN_CHANGED_FILES,
    AUTO_MIN_CHANGED_LINES,
    acceptance_decision,
)
from bit_agent.runtime.infrastructure.acceptance import AcceptanceWorkspace
from bit_agent.runtime.infrastructure.changes import ChangeJournal
from bit_agent.tools.apply_patch import patch_changed_lines
from bit_agent.tools.models import ToolMetadata, ToolResult, ToolStatus


def small_patch(name: str, lines: int = 3) -> str:
    body = "".join(f"+line {number}\n" for number in range(lines))
    return f"*** Begin Patch\n*** Add File: {name}\n{body}*** End Patch\n"


def test_patch_line_count_ignores_file_headers() -> None:
    diff = "--- a/x.py\n+++ b/x.py\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n"
    assert patch_changed_lines(diff) == 2
    assert patch_changed_lines(small_patch("a.py", 5)) == 5
    assert patch_changed_lines(None) == 0


@pytest.mark.parametrize(
    ("mode", "paths", "lines", "required"),
    [
        ("auto", {"a.py"}, 10, False),
        ("auto", {"a.py"}, AUTO_MIN_CHANGED_LINES, True),
        ("auto", {f"m{n}.py" for n in range(AUTO_MIN_CHANGED_FILES)}, 3, True),
        ("auto", {"a.py", "README.md", "notes.txt"}, 5, False),
        ("always", {"a.py"}, 1, True),
        ("off", {f"m{n}.py" for n in range(9)}, 999, False),
    ],
)
def test_decision_follows_mode_and_change_size(mode, paths, lines, required) -> None:
    decided, reason = acceptance_decision(mode, paths, lines)
    assert decided is required and reason


async def passed(root, changed, call_id, originals=None) -> ToolResult:
    return ToolResult(
        tool_call_id=call_id,
        tool_name="verify_project",
        status=ToolStatus.SUCCESS,
        output={"outcome": "PASSED", "checks": []},
        metadata=ToolMetadata(duration_ms=0),
    )


async def context() -> dict:
    return {"user_requests": []}


def provider(root: Path, mode: str, inherited_lines: int = 0) -> DelegatingToolProvider:
    (root / "project").mkdir(parents=True, exist_ok=True)
    return DelegatingToolProvider(
        root / "project",
        "off",
        InMemoryEventSink(),
        root / "artifacts",
        permission_mode="edit",
        journal=ChangeJournal(root / "project", root / "artifacts"),
        verifier=passed,
        acceptance_workspace=AcceptanceWorkspace,
        acceptance_context=context,
        acceptance_mode=mode,
        inherited_changed_lines=inherited_lines,
    )


async def patch_and_verify(tools: DelegatingToolProvider, lines: int) -> ToolResult:
    patch = json.dumps({"patch": small_patch("todo.py", lines)})
    assert (await tools.call_tool("apply_patch", "p", patch)).status is ToolStatus.SUCCESS
    return await tools.call_tool("verify_project", "v", "{}")


@pytest.mark.asyncio
async def test_small_change_skips_acceptance_and_says_so(tmp_path: Path) -> None:
    tools = provider(tmp_path, "auto")
    result = await patch_and_verify(tools, 4)
    assert result.output["acceptance"] == "skipped"
    assert "4 行" in result.output["acceptance_reason"]
    assert "不要调用 verify_task" in result.output["next_step"]
    refused = await tools.call_tool("verify_task", "t", json.dumps({"focus": ""}))
    assert refused.error.code == "ACCEPTANCE_NOT_APPLICABLE"
    assert "直接给出最终回答" in refused.error.message


@pytest.mark.asyncio
async def test_large_or_inherited_change_still_requires_acceptance(tmp_path: Path) -> None:
    large = await patch_and_verify(provider(tmp_path / "a", "auto"), AUTO_MIN_CHANGED_LINES)
    assert large.output["acceptance"] == "required"
    # 上一轮没验证完的 80 行改动，“继续”时加上本轮 2 行仍然算大改动。
    resumed = await patch_and_verify(provider(tmp_path / "b", "auto", inherited_lines=80), 2)
    assert resumed.output["acceptance"] == "required"
    always = await patch_and_verify(provider(tmp_path / "c", "always"), 1)
    assert always.output["acceptance"] == "required"
    assert "调用 verify_task" in always.output["next_step"]


@pytest.mark.asyncio
async def test_off_mode_hides_the_acceptance_tool(tmp_path: Path) -> None:
    tools = provider(tmp_path, "off")
    names = [tool["name"] for tool in await tools.model_tools()]
    assert "verify_task" not in names and "verify_project" in names
    result = await patch_and_verify(tools, 200)
    assert result.output["acceptance"] == "skipped"
    refused = await tools.call_tool("verify_task", "t", json.dumps({"focus": ""}))
    assert refused.error.code == "ACCEPTANCE_NOT_APPLICABLE"


def record(
    name: str,
    output: dict | None,
    *,
    ok: bool = True,
    code: str | None = None,
    arguments: dict | None = None,
    affected: list[str] | None = None,
) -> ToolCallRecord:
    return ToolCallRecord.from_tool_result(
        round_number=1,
        raw_arguments=json.dumps(arguments or {}),
        result=ToolResult(
            tool_call_id="c",
            tool_name=name,
            status=ToolStatus.SUCCESS if ok else ToolStatus.ERROR,
            output=output,
            error={"code": code, "message": "x", "retryable": False} if code else None,
            metadata=ToolMetadata(duration_ms=0, affected_paths=affected or []),
        ),
    )


def test_skipped_acceptance_lets_the_agent_finish_after_basic_checks() -> None:
    state = VerificationState(require_independent_acceptance=True)
    state.observe(
        "apply_patch",
        record("apply_patch", {}, arguments={"patch": small_patch("a.py")}, affected=["a.py"]),
    )
    reason = "本轮改动 3 行、1 个代码文件，改动较小，不做独立验收"
    state.observe(
        "verify_project",
        record(
            "verify_project",
            {"outcome": "PASSED", "acceptance": "skipped", "acceptance_reason": reason},
        ),
    )
    assert not state.has_unverified_changes and state.status == "PASSED"
    assert reason in state.notes
    state.observe(
        "verify_task", record("verify_task", None, ok=False, code="ACCEPTANCE_NOT_APPLICABLE")
    )
    assert not state.has_unverified_changes, "“不需要验收”的提示不能把改动重新标成未验证"


def test_required_acceptance_still_blocks_finishing() -> None:
    state = VerificationState(require_independent_acceptance=True)
    state.observe("apply_patch", record("apply_patch", {}, affected=["a.py"]))
    state.observe(
        "verify_project", record("verify_project", {"outcome": "PASSED", "acceptance": "required"})
    )
    assert state.has_unverified_changes


def test_unverified_line_count_survives_a_stopped_round() -> None:
    state = VerificationState(require_independent_acceptance=True)
    state.observe(
        "apply_patch",
        record("apply_patch", {}, arguments={"patch": small_patch("a.py", 7)}, affected=["a.py"]),
    )
    memory = WorkingMemory(thread_id="t", objective="x")
    state.save_to(memory)
    assert memory.verification_changed_lines == 7 and memory.verification_paths == ["a.py"]
    resumed = VerificationState(require_independent_acceptance=True)
    resumed.restore(memory, patch_interrupted=False)
    assert resumed.changed_lines == 7
    resumed.observe(
        "verify_project",
        record(
            "verify_project",
            {"outcome": "PASSED", "acceptance": "skipped", "acceptance_reason": "small"},
        ),
    )
    resumed.save_to(memory)
    assert memory.verification_changed_lines == 0, "验证完成后清零"
