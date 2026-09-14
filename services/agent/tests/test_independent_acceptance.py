"""Offline acceptance of tester isolation, evidence, SDK execution and persistence."""

import asyncio
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from bit_agent.agent.runtime import run_agent
from bit_agent.memory.models import WorkingMemory
from bit_agent.observability import InMemoryEventSink
from bit_agent.runtime.application.acceptance import AcceptanceToolProvider, run_acceptance
from bit_agent.runtime.application.delegation import DelegatingToolProvider
from bit_agent.runtime.application.interaction import TaskInteraction
from bit_agent.runtime.bootstrap import create_runtime
from bit_agent.runtime.domain.acceptance import AcceptanceReport
from bit_agent.runtime.infrastructure.acceptance import AcceptanceWorkspace
from bit_agent.runtime.infrastructure.changes import ChangeJournal
from bit_agent.runtime.infrastructure.storage import LocalStorage
from bit_agent.runtime.infrastructure.verification import verify_project
from bit_agent.sandbox.base import SandboxResult
from bit_agent.sandbox.docker import DockerSandbox
from bit_agent.tools.models import ToolMetadata, ToolResult, ToolStatus


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    (root / "pyproject.toml").write_text(
        '[project]\nname="fixture"\nversion="0.1"\n[tool.ruff.lint]\nselect=["E", "F"]\n'
    )
    (root / "app.py").write_text("def add(a, b):\n    return a + b\n")
    (root / "tests").mkdir()
    (root / "tests/test_existing.py").write_text("def test_existing():\n    assert True\n")
    (root / ".env").write_text("secret-do-not-copy")
    return root


@pytest.fixture
def sandbox(monkeypatch):
    commands = []

    async def run(self, root, command, timeout):
        commands.append((root, command, timeout, self.environment_kind))
        return SandboxResult(container_id="fixture", exit_code=0, stdout="1 passed")

    monkeypatch.setattr(DockerSandbox, "run", run)
    return commands


def report(verdict="PASSED", ids=None):
    return {
        "verdict": verdict,
        "summary": "按用户需求验证加法",
        "checks": [
            {
                "requirement": "两个数相加",
                "status": verdict,
                "evidence_ids": ["execute"] if ids is None else ids,
            }
        ],
        "unverified": [],
    }


async def invoke(provider, name, arguments, identifier="execute"):
    return await provider.call_tool(name, identifier, json.dumps(arguments))


async def test_snapshot_and_generated_tests_never_change_source(project, tmp_path):
    artifacts = tmp_path / "artifacts"
    async with AcceptanceWorkspace(project, artifacts) as workspace:
        copied = workspace.root
        assert not (copied / ".env").exists()
        assert await workspace.unchanged()
        target = await workspace.write_test("", "test_add.py", "def test_add():\n    assert 1+1==2")
        assert (copied / target).is_file()
        assert not (project / target).exists()
        assert await workspace.unchanged()
        assert (artifacts / "tests" / target).is_file()
        (project / "app.py").write_text("external change")
        assert not await workspace.unchanged()
    assert not copied.exists()


@pytest.mark.parametrize(
    "filename",
    [
        "app.py",
        "../test_x.py",
        "conftest.py",
        ".env",
        "test_x.py/other",
        "C:\\test_x.py",
        "package.json",
    ],
)
async def test_only_new_test_filenames_are_writable(project, tmp_path, filename):
    async with AcceptanceWorkspace(project, tmp_path / "artifacts") as workspace:
        with pytest.raises(ValueError):
            await workspace.write_test("", filename, "content")


@pytest.mark.parametrize("path", ["..", "../outside", "C:/outside", ".git"])
async def test_test_writer_rejects_escape_and_protected_paths(project, tmp_path, path):
    async with AcceptanceWorkspace(project, tmp_path / "artifacts") as workspace:
        with pytest.raises(ValueError):
            await workspace.write_test(path, "test_x.py", "content")


async def test_docker_command_is_fixed_and_language_explicit(project, tmp_path, sandbox):
    (project / "package.json").write_text(
        json.dumps({"name": "fixture", "scripts": {"test": "vitest run"}})
    )
    (project / "tests/test_example.test.ts").write_text("test code")
    async with AcceptanceWorkspace(project, tmp_path / "artifacts") as workspace:
        await workspace.run_test("", "tests/test_existing.py", "python", "py")
        await workspace.run_test("", "tests/test_example.test.ts", "node", "js")
        with pytest.raises(ValueError):
            await workspace.run_test("", "app.py", "python", "bad")
    assert sandbox[0][1] == ["python", "-m", "pytest", "-q", "--", "tests/test_existing.py"]
    assert sandbox[1][1][-2:] == ["--", "./tests/test_example.test.ts"]
    assert sandbox[1][3] == "node"


async def test_tool_set_and_evidence_validation(project, tmp_path, sandbox):
    async with AcceptanceWorkspace(project, tmp_path / "artifacts") as workspace:
        provider = AcceptanceToolProvider(workspace)
        names = {schema["name"] for schema in await provider.model_tools()}
        assert names == {
            "list_files",
            "read_file",
            "search_code",
            "write_acceptance_test",
            "run_acceptance_test",
            "submit_acceptance_report",
        }
        assert (await invoke(provider, "apply_patch", {})).status == ToolStatus.ERROR
        assert (await invoke(provider, "submit_acceptance_report", report())).status == "ERROR"
        result = await invoke(
            provider,
            "run_acceptance_test",
            {"project": "", "target": "tests", "language": "python"},
        )
        assert result.output["evidence_id"] == "execute"
        assert (await invoke(provider, "submit_acceptance_report", report())).status == "SUCCESS"
        await invoke(
            provider,
            "write_acceptance_test",
            {"project": "", "filename": "test_add.py", "content": "assert True"},
        )
        assert provider.report is None
        assert (await invoke(provider, "submit_acceptance_report", report())).status == "ERROR"
        await invoke(
            provider,
            "run_acceptance_test",
            {"project": "", "target": "tests", "language": "python"},
            "fresh",
        )
        assert (
            await invoke(provider, "submit_acceptance_report", report(ids=["fresh"]))
        ).status == "SUCCESS"
        with pytest.raises(ValueError):
            provider._validate_report(AcceptanceReport.model_validate(report(ids=[])))


async def test_missing_target_and_failed_runs_cannot_reuse_old_success(project, tmp_path, sandbox):
    async with AcceptanceWorkspace(project, tmp_path / "artifacts") as workspace:
        provider = AcceptanceToolProvider(workspace)
        await invoke(
            provider,
            "run_acceptance_test",
            {"project": "", "target": "tests", "language": "python"},
        )
        missing = await invoke(
            provider,
            "run_acceptance_test",
            {"project": "", "target": "tests/missing.py", "language": "python"},
            "missing",
        )
        assert missing.status == "ERROR"
        assert len(provider.evidence) == 2
        assert (await invoke(provider, "submit_acceptance_report", report())).status == "ERROR"


class TestModel:
    """Exercise the real installed SDK Runner with deterministic Responses responses."""

    __test__ = False

    def __init__(self, *, submit=True, write=True):
        self.responses = self
        self.inputs = []
        self.submit = submit
        self.write = write

    def create(self, **request):
        self.inputs.append(request)
        completed = {
            item["call_id"]: json.loads(item["output"])
            for item in request["input"]
            if item.get("type") == "function_call_output"
        }
        if self.write and "write" not in completed:
            return self.call(
                "write_acceptance_test",
                "write",
                {
                    "project": "",
                    "filename": "test_add.py",
                    "content": (
                        "from app import add\n\ndef test_add():\n    assert add(1, 2) == 3\n"
                    ),
                },
            )
        if "execute" not in completed:
            target = completed["write"]["output"]["target"] if self.write else "tests"
            return self.call(
                "run_acceptance_test",
                "execute",
                {
                    "project": "",
                    "target": target,
                    "language": "python",
                },
            )
        if self.submit and "report" not in completed:
            return self.call("submit_acceptance_report", "report", report())
        return SimpleNamespace(output=[], output_text="已通过")

    @staticmethod
    def call(name, identifier, arguments):
        return SimpleNamespace(
            output=[
                SimpleNamespace(
                    type="function_call",
                    name=name,
                    call_id=identifier,
                    arguments=json.dumps(arguments),
                )
            ],
            output_text="",
        )


async def acceptance_context(project, tmp_path):
    async with AcceptanceWorkspace(project, tmp_path / "unused") as workspace:
        return {
            "requirements": {"user_requests": [{"objective": "实现加法"}]},
            "baseline": {"output": {"snapshot_id": workspace.snapshot_id}},
            "author_focus_untrusted": "作者认为已经完成",
        }


@pytest.mark.parametrize("submit", [True, False])
async def test_real_sdk_tester_must_submit_evidence_report(project, tmp_path, sandbox, submit):
    client = TestModel(submit=submit)
    result = await run_acceptance(
        root=project,
        artifacts=tmp_path / "artifacts",
        call_id="verify",
        context=await acceptance_context(project, tmp_path),
        workspace_factory=AcceptanceWorkspace,
        sink=InMemoryEventSink(),
        response_client=client,
        model_name="fixture",
    )
    assert result.output["verdict"] == ("PASSED" if submit else "NOT_VERIFIED"), result
    saved = json.loads(Path(result.output["report_path"]).read_text(encoding="utf-8"))
    assert saved["verdict"] == result.output["verdict"]
    assert saved["evidence"][0]["command"][0] == "python"
    first = client.inputs[0]
    developer = [item["content"] for item in first["input"] if item.get("role") == "developer"]
    assert any("独立验收测试 Agent" in content for content in developer)
    assert "delegate_tasks" not in {tool["name"] for tool in first["tools"]}
    assert not list((project / "tests").glob("bit_agent_acceptance_*"))
    assert not sandbox[0][0].exists(), "disposable workspace must be cleaned"


async def test_changed_source_and_stale_baseline_do_not_pass(project, tmp_path, sandbox):
    context = await acceptance_context(project, tmp_path)
    (project / "app.py").write_text("new version")
    client = TestModel()
    result = await run_acceptance(
        root=project,
        artifacts=tmp_path / "artifacts",
        call_id="verify",
        context=context,
        workspace_factory=AcceptanceWorkspace,
        sink=InMemoryEventSink(),
        response_client=client,
        model_name="fixture",
    )
    assert result.output["verdict"] == "NOT_VERIFIED"
    assert client.inputs == [], "reject stale baseline before spending model tokens"


async def test_cancellation_saves_evidence_and_cleans_workspace(project, tmp_path, monkeypatch):
    entered = asyncio.Event()
    cleaned = asyncio.Event()
    roots = []

    async def blocked(self, root, command, timeout):
        roots.append(root)
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.set()

    monkeypatch.setattr(DockerSandbox, "run", blocked)
    context = await acceptance_context(project, tmp_path)
    task = asyncio.create_task(
        run_acceptance(
            root=project,
            artifacts=tmp_path / "artifacts",
            call_id="verify",
            context=context,
            workspace_factory=AcceptanceWorkspace,
            sink=InMemoryEventSink(),
            response_client=TestModel(),
            model_name="fixture",
        )
    )
    await asyncio.wait_for(entered.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cleaned.is_set()
    assert not roots[0].exists()
    saved = list((tmp_path / "artifacts").glob("acceptance-*/report.json"))
    assert len(saved) == 1
    assert json.loads(saved[0].read_text(encoding="utf-8"))["verdict"] == "NOT_VERIFIED"
    assert list((tmp_path / "artifacts").glob("acceptance-*/tests/**/test_add.py"))


async def task_control(tmp_path):
    storage = LocalStorage(tmp_path / "data")
    await storage.call(
        "create",
        {
            "task_id": "task",
            "session_id": "session",
            "objective": "原始需求",
            "workspace_root": str(tmp_path),
            "multi_agent_mode": "off",
            "status": "RUNNING",
            "created_at": "2026-09-12",
            "updated_at": "2026-09-12",
            "started_at": "2026-09-12",
        },
    )
    return TaskInteraction(storage, "task")


async def test_child_pause_keeps_user_updates_for_parent_and_never_seals(tmp_path):
    control = await task_control(tmp_path)
    try:
        assert await control.acceptance_boundary(True) == []
        assert not control.sealed
        await control.request({"action": "pause"})
        waiting = asyncio.create_task(control.acceptance_boundary())
        for _ in range(100):
            task = await control.storage.call("get_task", "task")
            if task["status"] == "PAUSED":
                break
            await asyncio.sleep(0.005)
        assert not waiting.done()
        await control.request({"action": "supplement", "text": "增加负数边界"})
        with pytest.raises(RuntimeError, match="用户要求已改变"):
            await waiting
        updates = await control.boundary()
        assert updates[0]["text"] == "增加负数边界"
        assert not control.sealed
        context = await control.storage.call("acceptance_context", "session")
        assert context["user_requests"][0]["objective"] == "原始需求"
        assert context["user_requests"][0]["updates"][0]["text"] == "增加负数边界"
    finally:
        control.storage.close()


async def test_off_mode_still_exposes_acceptance_and_read_only_blocks(project, tmp_path):
    async def context():
        return {"user_requests": [{"objective": "加法"}]}

    provider = DelegatingToolProvider(
        project,
        "off",
        InMemoryEventSink(),
        tmp_path / "artifacts",
        permission_mode="read_only",
        journal=ChangeJournal(project, tmp_path / "journal"),
        verifier=verify_project,
        acceptance_workspace=AcceptanceWorkspace,
        acceptance_context=context,
    )
    names = {item["name"] for item in await provider.model_tools()}
    assert "verify_task" in names and "delegate_tasks" not in names
    assert (await invoke(provider, "verify_task", {"focus": ""})).error.code == "PERMISSION_DENIED"
    provider.permission_mode = "edit"
    assert (
        await invoke(provider, "verify_task", {"focus": ""})
    ).error.code == "ACCEPTANCE_NOT_VERIFIED"


async def test_baseline_is_explicitly_not_acceptance(project, sandbox):
    result = await verify_project(project, ["app.py"], "base")
    assert result.status == "SUCCESS"
    assert result.output["scope"] == "baseline"
    assert not result.output["acceptance_verified"]
    assert len(result.output["checks"]) == 2


@pytest.mark.parametrize("revise_after_pass", [False, True])
async def test_main_runner_baseline_alone_cannot_finish_and_state_is_saved(
    project, revise_after_pass
):
    class Provider:
        def __init__(self):
            self.calls = []

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
                for name in ["apply_patch", "verify_project", "verify_task"]
            ]

        async def call_tool(self, name, identifier, arguments):
            self.calls.append(name)
            return ToolResult(
                tool_name=name,
                tool_call_id=identifier,
                status=ToolStatus.SUCCESS,
                output={"verdict": "PASSED"} if name == "verify_task" else {},
                metadata=ToolMetadata(
                    duration_ms=0, affected_paths=["app.py"] if name == "apply_patch" else []
                ),
            )

    class Author:
        def __init__(self):
            self.responses = self
            self.index = 0

        def create(self, **request):
            self.index += 1
            sequence = {1: "apply_patch", 2: "verify_project", 4: "verify_task"}
            if revise_after_pass:
                sequence.update({5: "apply_patch", 6: "verify_project", 8: "verify_task"})
            if self.index in sequence:
                return TestModel.call(sequence[self.index], str(self.index), {})
            return SimpleNamespace(output=[], output_text="完成")

    snapshots = []

    async def save(state, memory):
        snapshots.append((state, memory.model_copy(deep=True)))

    result = await run_agent(
        "实现加法",
        workspace_root=project,
        response_client=Author(),
        model_name="fixture",
        tool_provider=Provider(),
        event_sink=InMemoryEventSink(),
        save_progress=save,
        require_independent_acceptance=True,
    )
    assert result.status == "COMPLETED", result.error
    assert result.acceptance_status == "PASSED"
    assert sum(call.tool_name == "verify_task" for call in result.tool_calls) == (
        2 if revise_after_pass else 1
    )
    assert any(
        memory.basic_checks_passed
        and memory.has_unverified_changes
        and memory.acceptance_status == "NOT_RUN"
        for _, memory in snapshots
    )
    assert not snapshots[-1][1].has_unverified_changes
    assert snapshots[-1][1].acceptance_status == "PASSED"
    assert WorkingMemory(thread_id="old", objective="旧数据").acceptance_status == "NOT_RUN"


async def test_desktop_runtime_runs_nested_sdk_and_restores_both_results(
    project, tmp_path, sandbox, monkeypatch
):
    class Client:
        def __init__(self):
            self.responses = self
            self.tester = TestModel()

        def create(self, **request):
            names = {tool["name"] for tool in request["tools"]}
            if "write_acceptance_test" in names:
                return self.tester.create(**request)
            completed = {
                item["call_id"]
                for item in request["input"]
                if item.get("type") == "function_call_output"
            }
            if "patch" not in completed:
                return TestModel.call(
                    "apply_patch",
                    "patch",
                    {
                        "patch": (
                            "*** Begin Patch\n*** Update File: app.py\n@@\n"
                            " def add(a, b):\n-    return a + b\n+    return a + b  # addition\n"
                            "*** End Patch\n"
                        )
                    },
                )
            if "baseline" not in completed:
                return TestModel.call("verify_project", "baseline", {})
            if "acceptance" not in completed:
                return TestModel.call("verify_task", "acceptance", {"focus": "验证加法"})
            return SimpleNamespace(output=[], output_text="实现和验收完成")

    client = Client()
    monkeypatch.setitem(
        sys.modules, "bit_agent.llm.client", SimpleNamespace(client=client, model_name="fixture")
    )
    directory = tmp_path / "runtime"
    runtime = create_runtime(directory)
    await runtime.start()
    try:
        task = await runtime.create_task(
            {
                "objective": "实现加法",
                "workspace_root": str(project),
                "multi_agent_mode": "off",
                "permission_mode": "edit",
            }
        )
        await asyncio.wait_for(runtime._running[task["task_id"]], 10)
        stored = await runtime.get_task(task["task_id"])
        assert stored["status"] == "COMPLETED", stored
        assert stored["result"]["tests_passed"]
        assert stored["result"]["acceptance_status"] == "PASSED"
        assert len(client.tester.inputs) == 4
        assert len(sandbox) == 3, "two baseline commands and one independent test"
        events = await runtime.read_events(task["task_id"])
        assert any(event["data"].get("agent_id", "").startswith("acceptance-") for event in events)
    finally:
        await runtime.close()
    restored = LocalStorage(directory)
    try:
        memory = await restored.call("load_memory", task["session_id"])
        assert memory.basic_checks_passed and memory.acceptance_status == "PASSED"
        assert memory.latest_test_status == "PASSED"
        history = (await restored.call("load_context", task["session_id"]))["history"]
        results = {
            item["call_id"]: json.loads(item["output"])
            for item in history
            if item.get("type") == "function_call_output"
        }
        assert results["baseline"]["output"]["scope"] == "baseline"
        assert results["acceptance"]["output"]["verdict"] == "PASSED"
        assert "execute" not in results, "child raw dialogue must not replace parent context"
    finally:
        restored.close()


@pytest.mark.skipif(
    os.getenv("BIT_AGENT_LIVE_ACCEPTANCE") != "1",
    reason="显式开启真实 Docker 验收；模型仍使用本地 fixture",
)
@pytest.mark.parametrize("broken", [False, True])
async def test_real_docker_baseline_and_new_acceptance_tests(project, tmp_path, broken):
    if broken:
        (project / "app.py").write_text("def add(a, b):\n    return a - b\n")
    baseline = await verify_project(project, ["app.py"], "live-baseline")
    assert baseline.status == "SUCCESS", baseline.model_dump_json(indent=2)

    class Model(TestModel):
        def create(self, **request):
            response = super().create(**request)
            if broken and response.output and response.output[0].name == "submit_acceptance_report":
                response.output[0].arguments = json.dumps(report("FAILED"))
            return response

    result = await run_acceptance(
        root=project,
        artifacts=tmp_path / "artifacts",
        call_id="live-acceptance",
        context=await acceptance_context(project, tmp_path),
        workspace_factory=AcceptanceWorkspace,
        sink=InMemoryEventSink(),
        response_client=Model(),
        model_name="fixture",
    )
    assert result.output["verdict"] == ("FAILED" if broken else "PASSED"), result.model_dump_json(
        indent=2
    )
    evidence = result.output["evidence"][0]
    assert evidence["exit_code"] == (1 if broken else 0), evidence
    assert ("failed" if broken else "passed") in evidence["stdout"].lower()
