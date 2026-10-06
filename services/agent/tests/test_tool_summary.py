"""界面工具行下面的一句话结果，以及差异和工具调用的对应关系。"""

import json

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
            "无法自动验证",
        ),
        ("verify_task", result("verify_task", {"verdict": "PASSED"}), "验收通过"),
        ("run_tests", result("run_tests", error="2 tests failed\ndetails"), "2 tests failed"),
        ("ask_user", result("ask_user", {"text": "用方案 A"}), "用方案 A"),
    ],
)
def test_result_summary(name, tool_result, expected):
    assert result_summary(name, tool_result) == expected


def check(command, exit_code, stdout="", **extra):
    return {
        "command": command,
        "exit_code": exit_code,
        "stdout": stdout,
        "start_error": None,
        "timed_out": False,
        **extra,
    }


PYTEST = ["python", "-m", "pytest", "-q"]
RUFF = ["python", "-m", "ruff", "check", "--output-format=concise", "a.py"]


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        (
            {
                "outcome": "PASSED",
                "checks": [
                    check(PYTEST, 0, "....\n13 passed in 0.2s\n"),
                    check(RUFF, 0, "All checks passed!\n"),
                ],
            },
            "pytest 13 个通过，ruff 无问题",
        ),
        (
            {
                "outcome": "PASSED",
                "acceptance": "skipped",
                "checks": [check(PYTEST, 0, "3 passed in 0.1s")],
            },
            "pytest 3 个通过，无需独立验收",
        ),
        (
            {
                "outcome": "FAILED",
                "checks": [
                    check(PYTEST, 1, "2 failed, 11 passed in 1s"),
                    check(RUFF, 1, "a.py:1:1: F401 x\na.py:2:1: E9 y\n"),
                ],
            },
            "出现新的失败：pytest 2 个失败，11 个通过，ruff 2 个问题",
        ),
        (
            {
                "outcome": "PASSED",
                "checks": [check(PYTEST, 1, "1 failed, 4 passed", status="PRE_EXISTING")],
            },
            "pytest 1 个失败，4 个通过（修改前就有）",
        ),
        (
            {"outcome": "PASSED", "checks": [check(["npm.cmd", "run", "test"], 0)]},
            "npm run test 通过",
        ),
        (
            {"outcome": "UNVERIFIED", "unverified": [{"reason": "本机 Python 缺少 pytest"}]},
            "无法自动验证：本机 Python 缺少 pytest",
        ),
    ],
)
def test_basic_check_summary_names_what_actually_ran(output, expected):
    assert result_summary("verify_project", result("verify_project", output)) == expected


def test_patch_summary_counts_added_and_removed_lines():
    patch = "*** Begin Patch\n*** Update File: a.py\n@@\n-old\n+new\n+more\n*** End Patch\n"
    arguments = json.dumps({"patch": patch})
    assert (
        result_summary("apply_patch", result("apply_patch", "ok", paths=["a.py"]), arguments)
        == "+2 −1"
    )
    two = result("apply_patch", "ok", paths=["a.py", "b.py"])
    assert result_summary("apply_patch", two, arguments) == "2 个文件 +2 −1"


def test_unfinished_acceptance_says_why():
    output = {"verdict": "NOT_VERIFIED", "summary": "命令行子进程测试没有捕获到输出。其余已验证"}
    assert (
        result_summary("verify_task", result("verify_task", output, error="x"))
        == "验收未完成：命令行子进程测试没有捕获到输出"
    )
    refused = result("verify_task", error="不需要独立验收：改动较小")
    assert result_summary("verify_task", refused) == "不需要独立验收：改动较小"


def test_public_changes_carry_the_tool_call_id(tmp_path):
    journal = ChangeJournal(tmp_path, tmp_path / "artifacts")
    entry = journal.prepare("call-7", "*** Begin Patch\n*** Add File: a.py\n+x\n*** End Patch\n")
    journal.begin(entry)
    (tmp_path / "a.py").write_bytes(b"x\n")
    journal.finish(entry)
    assert journal.public()["changes"][0]["call_id"] == "call-7"
