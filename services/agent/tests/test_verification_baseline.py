"""修改后的基础检查：前后对比、无法验证、不需要验证和项目自定义验证命令。"""

import asyncio
import base64
import json
from pathlib import Path

import pytest
from bit_agent.agent.result import ToolCallRecord
from bit_agent.agent.verification import VerificationState
from bit_agent.observability import InMemoryEventSink
from bit_agent.runtime.application.delegation import DelegatingToolProvider
from bit_agent.runtime.application.interaction import TaskInteraction
from bit_agent.runtime.infrastructure.changes import ChangeJournal
from bit_agent.runtime.infrastructure.storage import LocalStorage
from bit_agent.runtime.infrastructure.verification import (
    compare_with_baseline,
    verification_plan,
    verify_project,
)
from bit_agent.runtime.infrastructure.verification_support import execution
from bit_agent.sandbox import OSSandbox
from bit_agent.sandbox.base import SandboxResult
from bit_agent.tools.command_runtime import python_executable
from bit_agent.tools.models import ToolMetadata, ToolResult, ToolStatus


async def control(tmp_path: Path) -> TaskInteraction:
    storage = LocalStorage(tmp_path / "data")
    await storage.call(
        "create",
        {
            "task_id": "task",
            "session_id": "session",
            "multi_agent_mode": "off",
            "objective": "test",
            "workspace_root": str(tmp_path),
            "status": "RUNNING",
            "created_at": "2026-09-30T00:00:00Z",
            "updated_at": "2026-09-30T00:00:00Z",
            "started_at": "2026-09-30T00:00:00Z",
            "completed_at": None,
            "worker_id": "local",
            "run_id": None,
            "result": None,
            "error": None,
        },
    )
    return TaskInteraction(storage, "task")


async def until(predicate) -> None:
    for _ in range(400):
        if predicate():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("等待状态超时")


def encoded(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


@pytest.fixture
def python_project(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    (root / "pyproject.toml").write_text('[project]\nname="demo"\nversion="0.1"\n')
    (root / "app.py").write_text("def add(a, b):\n    return a - b\n")
    (root / "tests").mkdir()
    (root / "tests" / "test_app.py").write_text("def test_add():\n    pass\n")
    return root


@pytest.fixture
def sandbox(monkeypatch):
    """按工作区里 app.py 的内容决定命令结果，并记录每次运行发生在哪个目录。"""
    calls: list[dict] = []
    behaviour: dict = {}

    async def run(self, root, command, timeout, python_path=None):
        source = (root / "app.py").read_text() if (root / "app.py").exists() else ""
        calls.append(
            {
                "root": root,
                "command": command,
                "source": source,
                "python_path": python_path,
            }
        )
        handler = behaviour.get("handler")
        if handler is None:
            return SandboxResult(exit_code=0, stdout="1 passed in 0.01s")
        return handler(command, source)

    monkeypatch.setattr(OSSandbox, "run", run)

    async def ready():
        return {"available": True, "message": "", "backend": "os"}

    monkeypatch.setattr(execution, "sandbox_status", ready)
    return calls, behaviour


def pytest_result(failed: list[str], passed: int) -> SandboxResult:
    lines = [f"FAILED {item} - AssertionError" for item in failed]
    summary = ", ".join(
        part
        for part in (
            f"{len(failed)} failed" if failed else "",
            f"{passed} passed" if passed else "",
        )
        if part
    )
    return SandboxResult(
        exit_code=1 if failed else 0,
        stdout="\n".join([*lines, f"{summary} in 0.10s"]),
    )


async def test_docs_only_change_needs_no_checks(python_project, sandbox):
    calls, _ = sandbox
    result = await verify_project(python_project, ["README.md", "docs/guide.rst"], "call")
    assert result.status is ToolStatus.SUCCESS
    assert result.output["outcome"] == "NOT_APPLICABLE"
    assert result.output["skipped_paths"] == ["README.md", "docs/guide.rst"]
    assert calls == []


async def test_python_change_lints_only_changed_files(python_project, sandbox):
    calls, _ = sandbox
    (python_project / "other.py").write_text("import os\n")
    result = await verify_project(python_project, ["app.py"], "call")
    assert result.output["outcome"] == "PASSED"
    assert [call["command"] for call in calls] == [
        [python_executable(python_project), "-m", "pytest", "-q", "-rfE"],
        [
            python_executable(python_project),
            "-m",
            "ruff",
            "check",
            "--no-cache",
            "--force-exclude",
            "--output-format=concise",
            "--select=E9,F",
            "app.py",
        ],
    ]


def test_projects_with_their_own_ruff_config_keep_their_rules(python_project):
    (python_project / "pyproject.toml").write_text(
        '[project]\nname="demo"\nversion="0.1"\n[tool.ruff.lint]\nselect=["E","F","I"]\n'
    )
    ruff = verification_plan(python_project, ["app.py"])["projects"][0]["commands"][1]
    assert "--select=E9,F" not in ruff


async def test_unsupported_language_is_unverified_not_failed(python_project, sandbox):
    calls, _ = sandbox
    (python_project / "server").mkdir()
    (python_project / "server" / "main.go").write_text("package main\n")
    # Go 文件不在 Python 项目目录之下时找不到所属项目。
    outside = python_project.parent / "go-only"
    outside.mkdir()
    (outside / "main.go").write_text("package main\n")
    result = await verify_project(outside, ["main.go"], "call")
    assert result.status is ToolStatus.ERROR
    assert result.error.code == "VERIFICATION_UNAVAILABLE"
    assert result.output["outcome"] == "UNVERIFIED"
    assert "verify.json" in result.output["unverified"][0]["reason"]
    assert calls == []


async def test_preexisting_failures_do_not_block(python_project, sandbox):
    calls, behaviour = sandbox

    def handler(command, source):
        if "pytest" in command:
            # 修改前后都有同一个旧失败；修改后另一个测试照常通过。
            return pytest_result(["tests/test_legacy.py::test_old"], passed=3)
        return SandboxResult(exit_code=0)

    behaviour["handler"] = handler
    (python_project / "app.py").write_text("def add(a, b):\n    return a + b\n")
    result = await verify_project(
        python_project,
        ["app.py"],
        "call",
        {"app.py": encoded("def add(a, b):\n    return a - b\n")},
    )
    assert result.status is ToolStatus.SUCCESS, result
    assert result.output["outcome"] == "PASSED"
    assert result.output["checks"][0]["status"] == "PRE_EXISTING"
    baseline_run = calls[1]
    assert baseline_run["root"] != python_project
    assert baseline_run["source"] == "def add(a, b):\n    return a - b\n"
    # 原工作区不会被改回去。
    assert (python_project / "app.py").read_text() == "def add(a, b):\n    return a + b\n"


async def test_new_failure_is_reported(python_project, sandbox):
    _, behaviour = sandbox

    def handler(command, source):
        if "pytest" in command:
            failures = ["tests/test_app.py::test_add"] if "+" in source else []
            return pytest_result(failures, passed=2)
        return SandboxResult(exit_code=0)

    behaviour["handler"] = handler
    (python_project / "app.py").write_text("def add(a, b):\n    return a + b\n")
    result = await verify_project(
        python_project, ["app.py"], "call", {"app.py": encoded("def add(a, b):\n    return 0\n")}
    )
    assert result.output["outcome"] == "FAILED"
    assert result.error.code == "VERIFICATION_FAILED"
    assert "tests/test_app.py::test_add" in result.output["checks"][0]["detail"]


async def test_failures_without_known_originals_stay_failed(python_project, sandbox):
    calls, behaviour = sandbox
    behaviour["handler"] = lambda command, source: pytest_result(["tests/t.py::x"], passed=1)
    result = await verify_project(python_project, ["app.py"], "call")
    assert result.output["outcome"] == "FAILED"
    assert len(calls) == 1, "没有修改前的内容，不能做对比"


async def test_partially_known_originals_are_not_compared(python_project, sandbox):
    calls, behaviour = sandbox
    behaviour["handler"] = lambda command, source: pytest_result(["tests/t.py::x"], passed=1)
    (python_project / "lib.py").write_text("x = 1\n")
    result = await verify_project(
        python_project, ["app.py", "lib.py"], "call", {"app.py": encoded("old\n")}
    )
    assert result.output["outcome"] == "FAILED"
    assert len(calls) == 1


async def test_os_sandbox_unavailable_is_unverified(python_project, sandbox, monkeypatch):
    calls, behaviour = sandbox
    behaviour["handler"] = lambda command, source: SandboxResult(
        exit_code=None, start_error="OS sandbox unavailable"
    )

    async def stopped():
        return {"available": False, "message": "OS 沙箱不可用", "backend": "os"}

    monkeypatch.setattr(execution, "sandbox_status", stopped)
    result = await verify_project(python_project, ["app.py"], "call", {"app.py": encoded("x\n")})
    assert result.output["outcome"] == "UNVERIFIED"
    assert "OS 沙箱不可用" in result.error.message
    assert len(calls) == 1, "OS 沙箱不可用时不再尝试其余命令"


@pytest.mark.parametrize(
    ("baseline_exit", "expected"),
    [(0, "FAILED"), (1, "UNVERIFIED")],
)
def test_generic_command_compares_exit_status(baseline_exit, expected):
    current = {"exit_code": 1, "stdout": "", "stderr": "", "start_error": None, "timed_out": False}
    baseline = {**current, "exit_code": baseline_exit}
    status, _ = compare_with_baseline(["npm", "run", "test"], current, baseline)
    assert status == expected


def test_ruff_compares_codes_per_file():
    command = ["python", "-m", "ruff", "check", "--output-format=concise", "app.py"]
    old = "app.py:1:8: F401 [*] `os` imported but unused\n"
    base = {"exit_code": 1, "stdout": old, "stderr": "", "start_error": None, "timed_out": False}
    same = {**base, "stdout": old.replace("1:8", "3:8")}
    assert compare_with_baseline(command, same, base)[0] == "PRE_EXISTING"
    worse = {**base, "stdout": old + "app.py:5:1: E711 comparison to None\n"}
    status, detail = compare_with_baseline(command, worse, base)
    assert status == "FAILED" and "E711" in detail


def test_pytest_without_any_passing_test_is_unverified():
    run = {
        "exit_code": 2,
        "stdout": "ERROR tests/test_app.py - ModuleNotFoundError\n1 error in 0.1s",
        "stderr": "",
        "start_error": None,
        "timed_out": False,
    }
    assert compare_with_baseline(["python", "-m", "pytest"], run, run)[0] == "UNVERIFIED"


def test_pytest_no_tests_collected():
    empty = {"exit_code": 5, "stdout": "no tests ran", "stderr": "", "start_error": None}
    empty["timed_out"] = False
    had = {**empty, "exit_code": 0, "stdout": "2 passed in 0.1s"}
    assert compare_with_baseline(["pytest"], empty, empty)[0] == "UNVERIFIED"
    assert compare_with_baseline(["pytest"], empty, had)[0] == "FAILED"


async def test_project_config_runs_local_custom_commands_and_skips(tmp_path, sandbox):
    calls, _ = sandbox
    (tmp_path / "server").mkdir()
    (tmp_path / "server" / "main.go").write_text("package main\n")
    (tmp_path / ".bit-agent").mkdir()
    (tmp_path / ".bit-agent" / "verify.json").write_text(
        json.dumps(
            {
                "projects": [
                    {
                        "path": "server",
                        "language": "custom",
                        "commands": [["go", "test", "./..."]],
                        "timeout_seconds": 600,
                    }
                ],
                "skip": ["scripts/*"],
            }
        )
    )
    result = await verify_project(tmp_path, ["server/main.go", "scripts/deploy.ps1"], "call", None)
    assert result.output["outcome"] == "PASSED", result
    assert calls[0]["command"] == ["go", "test", "./..."]
    assert calls[0]["root"] == (tmp_path / "server").resolve()
    assert result.output["skipped_paths"] == ["scripts/deploy.ps1"]


@pytest.mark.parametrize(
    "config",
    [
        "not json",
        json.dumps({"projects": [{"path": "..", "image": "x", "commands": [["a"]]}]}),
        json.dumps({"projects": [{"path": "", "commands": [["a"]]}]}),
        json.dumps({"projects": [{"path": "", "image": "bad image", "commands": [["a"]]}]}),
        json.dumps({"projects": [{"path": "", "language": "python", "commands": []}]}),
        json.dumps({"unknown": True}),
    ],
)
async def test_invalid_config_is_unverified(tmp_path, sandbox, config):
    calls, _ = sandbox
    (tmp_path / "pyproject.toml").write_text("")
    (tmp_path / ".bit-agent").mkdir()
    (tmp_path / ".bit-agent" / "verify.json").write_text(config)
    (tmp_path / "app.py").write_text("x = 1\n")
    result = await verify_project(tmp_path, ["app.py"], "call")
    assert result.output["outcome"] == "UNVERIFIED"
    assert "验证配置无效" in result.error.message
    assert calls == []


def test_plain_python_folder_is_recognised(tmp_path):
    # 真实遇到的项目：没有 pyproject.toml，只有脚本、tests/ 和 requirements-dev.txt。
    (tmp_path / "todo.py").write_text("x = 1\n")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_todo.py").write_text("def test_x():\n    pass\n")
    (tmp_path / "requirements-dev.txt").write_text("pytest>=7\n")
    plan = verification_plan(tmp_path, ["todo.py", "tests/test_todo.py", "README.md"])
    assert plan["unverifiable"] == []
    assert [(p["root"], p["language"]) for p in plan["projects"]] == [("", "python")]
    assert plan["skipped"] == ["README.md"]


def test_python_script_without_any_manifest_uses_workspace_root(tmp_path):
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "tool.py").write_text("x = 1\n")
    plan = verification_plan(tmp_path, ["scripts/tool.py"])
    assert [(p["root"], p["language"]) for p in plan["projects"]] == [("", "python")]
    assert plan["projects"][0]["commands"][1][-1] == "scripts/tool.py"


def test_monorepo_is_unverified_with_hint(tmp_path):
    (tmp_path / "package.json").write_text(json.dumps({"workspaces": ["packages/*"]}))
    plan = verification_plan(tmp_path, ["index.ts"])
    assert plan["projects"] == []
    assert "多包" in plan["unverifiable"][0]["reason"]


def test_journal_keeps_first_original(tmp_path):
    journal = ChangeJournal(tmp_path, tmp_path / "artifacts")
    (tmp_path / "a.py").write_bytes(b"one\n")
    for content in ("two", "three"):
        entry = journal.prepare(
            "call",
            f"*** Begin Patch\n*** Update File: a.py\n@@\n-{'one' if content == 'two' else 'two'}\n"
            f"+{content}\n*** End Patch\n",
        )
        journal.begin(entry)
        (tmp_path / "a.py").write_bytes(content.encode() + b"\n")
        journal.finish(entry)
    entry = journal.prepare("call", "*** Begin Patch\n*** Add File: b.py\n+new\n*** End Patch\n")
    journal.begin(entry)
    assert journal.originals() == {"a.py": encoded("one\n"), "b.py": None}


def call(name: str, output: dict, ok: bool, affected: list[str] | None = None) -> ToolCallRecord:
    return ToolCallRecord.from_tool_result(
        round_number=1,
        raw_arguments="{}",
        result=ToolResult(
            tool_call_id="c",
            tool_name=name,
            status=ToolStatus.SUCCESS if ok else ToolStatus.ERROR,
            output=output,
            error=None
            if ok
            else {"code": "VERIFICATION_UNAVAILABLE", "message": "x", "retryable": False},
            metadata=ToolMetadata(duration_ms=0, affected_paths=affected or []),
        ),
    )


@pytest.mark.parametrize("outcome", ["UNVERIFIED", "NOT_APPLICABLE"])
def test_state_allows_finishing_without_claiming_pass(outcome):
    state = VerificationState(require_independent_acceptance=True)
    state.observe("apply_patch", call("apply_patch", {}, True, ["main.go"]))
    assert state.has_unverified_changes and state.status == "NOT_RUN"
    output = {
        "outcome": outcome,
        "unverified": [{"paths": ["main.go"], "reason": "不支持"}],
        "notes": [],
    }
    state.observe("verify_project", call("verify_project", output, outcome != "UNVERIFIED"))
    assert not state.has_unverified_changes
    assert state.status == outcome
    assert not state.tests_passed
    if outcome == "UNVERIFIED":
        assert state.notes == ["不支持（main.go）"]


def test_state_stops_after_ignored_reminders():
    state = VerificationState()
    state.observe("apply_patch", call("apply_patch", {}, True, ["a.py"]))
    assert not any(state.reminded() for _ in range(3))
    assert state.reminded()
    state.observe("verify_project", call("verify_project", {"outcome": "FAILED"}, False))
    assert not state.reminded(), "运行过验证后重新计数"


PATCH = "*** Begin Patch\n*** Add File: {name}\n+x\n*** End Patch\n"


def provider(root: Path, interaction, mode: str = "confirm") -> DelegatingToolProvider:
    return DelegatingToolProvider(
        root,
        "off",
        InMemoryEventSink(),
        root / "artifacts",
        interaction,
        permission_mode=mode,
        journal=ChangeJournal(root, root / "artifacts"),
        verifier=verify_project,
    )


async def answer(interaction, option: str) -> None:
    await until(lambda: interaction.question is not None)
    question = interaction.question
    await interaction.request(
        {"action": "answer", "question_id": question["id"], "option_id": option}
    )
    await until(
        lambda: interaction.question is None or interaction.question["id"] != question["id"]
    )


async def test_verification_config_edit_needs_approval_even_in_edit_mode(tmp_path):
    interaction = await control(tmp_path)
    tools = provider(tmp_path, interaction, "edit")
    pending = asyncio.create_task(
        tools.call_tool(
            "apply_patch", "c1", json.dumps({"patch": PATCH.format(name=".bit-agent/verify.json")})
        )
    )
    await until(lambda: interaction.question is not None)
    options = [item["id"] for item in interaction.question["options"]]
    assert options == ["approve", "reject"], "验证配置不能整轮批准"
    await answer(interaction, "reject")
    result = await pending
    assert result.error.code == "PERMISSION_DENIED"
    assert not (tmp_path / ".bit-agent" / "verify.json").exists()
    interaction.storage.close()


async def test_approve_for_task_skips_later_questions_of_same_kind(tmp_path):
    interaction = await control(tmp_path)
    tools = provider(tmp_path, interaction)
    first = asyncio.create_task(
        tools.call_tool("apply_patch", "c1", json.dumps({"patch": PATCH.format(name="a.py")}))
    )
    await answer(interaction, "approve_task")
    assert (await first).status is ToolStatus.SUCCESS
    second = await tools.call_tool(
        "apply_patch", "c2", json.dumps({"patch": PATCH.format(name="b.py")})
    )
    assert second.status is ToolStatus.SUCCESS
    assert (tmp_path / "b.py").exists()
    # 删除仍然逐次确认。
    deleting = asyncio.create_task(
        tools.call_tool(
            "apply_patch",
            "c3",
            json.dumps({"patch": "*** Begin Patch\n*** Delete File: a.py\n*** End Patch\n"}),
        )
    )
    await until(lambda: interaction.question is not None)
    await answer(interaction, "reject")
    assert (await deleting).error.code == "PERMISSION_DENIED"
    assert (tmp_path / "a.py").exists()
    interaction.storage.close()


async def test_acceptance_requires_passed_baseline(tmp_path):
    async def unverified(root, changed, call_id, originals=None, *, environment_root=None):
        return ToolResult(
            tool_call_id=call_id,
            tool_name="verify_project",
            status=ToolStatus.ERROR,
            output={"outcome": "UNVERIFIED"},
            error={"code": "VERIFICATION_UNAVAILABLE", "message": "x", "retryable": False},
            metadata=ToolMetadata(duration_ms=0),
        )

    async def context():
        return {"user_requests": []}

    tools = DelegatingToolProvider(
        tmp_path,
        "off",
        InMemoryEventSink(),
        tmp_path / "artifacts",
        permission_mode="edit",
        journal=ChangeJournal(tmp_path, tmp_path / "artifacts"),
        verifier=unverified,
        acceptance_workspace=lambda root, artifacts: None,
        acceptance_context=context,
    )
    tools.baseline = await unverified(tmp_path, [], "c")
    result = await tools.call_tool("verify_task", "c", json.dumps({"focus": ""}))
    assert result.error.code == "ACCEPTANCE_NOT_APPLICABLE"
    assert "直接给出最终回答" in result.error.message


def test_refused_acceptance_after_unverified_baseline_does_not_reopen_changes():
    state = VerificationState(require_independent_acceptance=True)
    state.observe("apply_patch", call("apply_patch", {}, True, ["todo.py"]))
    state.observe("verify_project", call("verify_project", {"outcome": "UNVERIFIED"}, False))
    assert not state.has_unverified_changes
    state.observe("verify_task", call("verify_task", {}, False))
    assert not state.has_unverified_changes
    assert state.status == "UNVERIFIED" and state.acceptance_status == "NOT_RUN"


async def test_agent_finishes_instead_of_looping_when_nothing_can_be_verified(tmp_path):
    """真实遇到的循环：verify_project 无法验证 → verify_task 被拒绝 → 又被要求验证……"""
    from types import SimpleNamespace

    from bit_agent.agent.runtime import run_agent

    class Provider:
        calls: list[str] = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        async def model_tools(self):
            return [
                {
                    "type": "function",
                    "name": name,
                    "description": name,
                    "parameters": {"type": "object", "properties": {}},
                }
                for name in ("apply_patch", "verify_project", "verify_task")
            ]

        async def call_tool(self, name, identifier, arguments):
            self.calls.append(name)
            outputs = {
                "apply_patch": (ToolStatus.SUCCESS, {}, None),
                "verify_project": (
                    ToolStatus.ERROR,
                    {"outcome": "UNVERIFIED"},
                    "VERIFICATION_UNAVAILABLE",
                ),
                "verify_task": (ToolStatus.ERROR, None, "ACCEPTANCE_NOT_APPLICABLE"),
            }
            status, output, code = outputs[name]
            return ToolResult(
                tool_call_id=identifier,
                tool_name=name,
                status=status,
                output=output,
                error={"code": code, "message": "x", "retryable": False} if code else None,
                metadata=ToolMetadata(
                    duration_ms=0, affected_paths=["todo.py"] if name == "apply_patch" else []
                ),
            )

    class Model:
        def __init__(self):
            self.responses = self
            self.index = 0

        def create(self, **request):
            self.index += 1
            names = {1: "apply_patch", 2: "verify_project", 3: "verify_task"}
            if self.index in names:
                call_item = SimpleNamespace(
                    type="function_call",
                    call_id=str(self.index),
                    name=names[self.index],
                    arguments="{}",
                )
                return SimpleNamespace(output=[call_item], output_text="")
            return SimpleNamespace(output=[], output_text="已完成，但没有能运行的测试")

    provider = Provider()
    result = await run_agent(
        "做一个待办工具",
        workspace_root=tmp_path,
        response_client=Model(),
        model_name="fixture",
        tool_provider=provider,
        event_sink=InMemoryEventSink(),
        require_independent_acceptance=True,
    )
    assert result.status == "COMPLETED", result.error
    assert result.verification_status == "UNVERIFIED"
    assert provider.calls == ["apply_patch", "verify_project", "verify_task"]


async def test_passing_checks_run_in_original_workspace_without_copy(
    python_project, sandbox, monkeypatch
):
    calls, _ = sandbox

    async def unexpected_copy(*args):
        raise AssertionError("Passing checks must not copy the workspace")

    monkeypatch.setattr(execution, "write_baseline", unexpected_copy)
    result = await verify_project(python_project, ["app.py"], "call", {"app.py": encoded("old\n")})
    assert result.output["outcome"] == "PASSED"
    assert len(calls) == 2
    assert all(call["root"] == python_project for call in calls)


async def test_missing_check_tool_is_unverified_without_baseline_copy(python_project, sandbox):
    calls, behaviour = sandbox
    behaviour["handler"] = lambda command, source: (
        SandboxResult(1, stderr="python: No module named pytest")
        if "pytest" in command
        else SandboxResult(0)
    )
    result = await verify_project(python_project, ["app.py"], "call", {"app.py": encoded("old\n")})
    assert result.output["outcome"] == "UNVERIFIED"
    assert "缺少 pytest" in result.error.message
    assert all(call["root"] == python_project for call in calls)


async def test_baseline_copy_failure_cannot_report_success(python_project, sandbox, monkeypatch):
    _, behaviour = sandbox
    behaviour["handler"] = lambda command, source: pytest_result(["tests/t.py::x"], passed=1)

    async def denied(*args):
        raise OSError("copy denied")

    monkeypatch.setattr(execution, "write_baseline", denied)
    result = await verify_project(python_project, ["app.py"], "call", {"app.py": encoded("old\n")})
    assert result.output["outcome"] == "UNVERIFIED"
    assert "copy denied" in result.error.message
    assert result.output["verified"] is False


async def test_check_in_a_copy_uses_the_original_venv_and_the_copys_sources(
    python_project, tmp_path, sandbox
):
    """副本不复制 .venv：仍用原工作区的解释器，PYTHONPATH 指向副本，避免可编辑安装读到原目录。"""
    calls, _ = sandbox
    venv = python_project / ".venv"
    interpreter = venv / "Scripts" / "python.exe"
    interpreter.parent.mkdir(parents=True)
    interpreter.write_bytes(b"fixture")
    (venv / "pyvenv.cfg").write_text("home = C:\\Python\n")
    copy = tmp_path / "copy"
    copy.mkdir()
    for name in ("pyproject.toml", "app.py"):
        (copy / name).write_text((python_project / name).read_text())
    (copy / "src").mkdir()
    result = await verify_project(copy, ["app.py"], "call", environment_root=python_project)
    assert result.output["outcome"] == "PASSED"
    assert calls and all(call["command"][0] == str(interpreter) for call in calls)
    assert all(call["python_path"] == [copy.resolve() / "src", copy.resolve()] for call in calls)


async def test_check_without_any_venv_keeps_the_agent_python_and_no_python_path(
    python_project, sandbox
):
    calls, _ = sandbox
    await verify_project(python_project, ["app.py"], "call")
    assert calls and all(call["command"][0] == python_executable(python_project) for call in calls)
    assert all(call["python_path"] == [] for call in calls)


def test_python_executable_falls_back_to_the_workspace_root_venv(tmp_path):
    project = tmp_path / "packages" / "core"
    project.mkdir(parents=True)
    interpreter = tmp_path / ".venv" / "Scripts" / "python.exe"
    interpreter.parent.mkdir(parents=True)
    interpreter.write_bytes(b"fixture")
    assert python_executable(project, tmp_path) == str(interpreter)
    assert python_executable(project) != str(interpreter)


def test_verification_plan_selects_local_python_and_drops_image(python_project):
    interpreter = python_project / ".venv" / "Scripts" / "python.exe"
    interpreter.parent.mkdir(parents=True)
    interpreter.write_bytes(b"fixture")
    plan = verification_plan(python_project, ["app.py"])
    assert all(command[0] == str(interpreter) for command in plan["projects"][0]["commands"])
    assert "image" not in plan["projects"][0]
