"""界面工具行下面的一句话结果，以及差异和工具调用的对应关系。"""

import pytest
from bit_agent.agent.tool_dispatch import result_summary
from bit_agent.runtime.infrastructure.changes import ChangeJournal
from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus


def result(name, output=None, *, error=None, paths=None):
    return ToolResult(
        tool_call_id="c",
        tool_name=name,
        status=ToolStatus.ERROR if error else ToolStatus.SUCCESS,
        output=output,
        error=ToolError(code="X", message=error, retryable=False) if error else None,
        metadata=ToolMetadata(duration_ms=1, affected_paths=paths or []),
    )


@pytest.mark.parametrize(
    ("name", "tool_result", "expected"),
    [
        ("read_file", result("read_file", "1 a\n2 b\n3 c"), "3 行"),
        ("list_files", result("list_files", "a.py\nb.py"), "2 项"),
        ("search_code", result("search_code", ""), "没有匹配"),
        ("search_code", result("search_code", "a.py:1:x"), "1 处匹配"),
        ("apply_patch", result("apply_patch", "Patch applied", paths=["a", "b"]), "修改 2 个文件"),
        (
            "verify_project",
            result("verify_project", {"outcome": "UNVERIFIED"}, error="x"),
            "没有能运行的检查",
        ),
        ("verify_task", result("verify_task", {"verdict": "PASSED"}), "验收通过"),
        ("run_tests", result("run_tests", error="2 tests failed\ndetails"), "2 tests failed"),
        ("ask_user", result("ask_user", {"text": "用方案 A"}), "用方案 A"),
    ],
)
def test_result_summary(name, tool_result, expected):
    assert result_summary(name, tool_result) == expected


def test_public_changes_carry_the_tool_call_id(tmp_path):
    journal = ChangeJournal(tmp_path, tmp_path / "artifacts")
    entry = journal.prepare("call-7", "*** Begin Patch\n*** Add File: a.py\n+x\n*** End Patch\n")
    journal.begin(entry)
    (tmp_path / "a.py").write_bytes(b"x\n")
    journal.finish(entry)
    assert journal.public()["changes"][0]["call_id"] == "call-7"
