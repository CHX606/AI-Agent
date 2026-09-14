"""本地运行链路的验收。模型由假客户端代替，不访问真实模型服务。"""

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from bit_agent.agent.result import AgentRunResult, AgentRunStatus
from bit_agent.context.serialization import to_json_value
from bit_agent.memory.models import WorkingMemory
from bit_agent.runtime.application import service
from bit_agent.runtime.bootstrap import create_runtime
from bit_agent.runtime.infrastructure.storage import LocalStorage, SQLiteWorkingMemoryStore


class FakeClient:
    def __init__(self) -> None:
        self.responses = self
        self.calls: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> SimpleNamespace:
        request = to_json_value(kwargs)
        self.calls.append(request)
        users = [item["content"] for item in request["input"] if item.get("role") == "user"]
        names = {tool["name"] for tool in request["tools"]}
        if (
            users[-1] == "delegate now"
            and "delegate_tasks" in names
            and not any(item.get("type") == "function_call_output" for item in request["input"])
        ):
            call = SimpleNamespace(
                type="function_call",
                name="delegate_tasks",
                call_id="delegate-test",
                arguments=json.dumps(
                    {"tasks": [{"objective": "inspect A"}, {"objective": "inspect B"}]}
                ),
            )
            return SimpleNamespace(output=[call], output_text="")
        text = "reply: " + " | ".join(users)
        message = SimpleNamespace(
            type="message",
            role="assistant",
            content=[{"type": "output_text", "text": text, "annotations": []}],
        )
        return SimpleNamespace(output=[message], output_text=text)


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> FakeClient:
    fake = FakeClient()
    monkeypatch.setitem(
        sys.modules, "bit_agent.llm.client", SimpleNamespace(client=fake, model_name="fake")
    )
    return fake


async def finish(runtime: service.AgentRuntime, task: dict[str, Any]) -> dict[str, Any]:
    for _ in range(500):
        current = await runtime.get_task(task["task_id"])
        if (
            current
            and current["status"] in service.TERMINAL
            and task["task_id"] not in runtime._running
        ):
            return current
        await asyncio.sleep(0.01)
    raise AssertionError("本地假模型任务没有按时结束")


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", [None, 1, 57, 1000])
async def test_round_budget_reaches_runner_and_survives_restart(
    tmp_path: Path, client: FakeClient, monkeypatch: pytest.MonkeyPatch, limit: int | None
) -> None:
    budgets = []
    original = service.run_agent

    async def runner(*args: Any, **kwargs: Any) -> AgentRunResult:
        budgets.append(kwargs["max_tool_rounds"])
        return await original(*args, **kwargs)

    monkeypatch.setattr(service, "run_agent", runner)
    directory = tmp_path / "data"
    runtime = create_runtime(directory)
    await runtime.start()
    try:
        input = {"objective": "hello", "workspace_root": str(tmp_path), "multi_agent_mode": "off"}
        if limit is not None:
            input["max_tool_rounds"] = limit
        task = await runtime.create_task(input)
        expected = 100 if limit is None else limit
        assert task["max_tool_rounds"] == expected
        assert (await finish(runtime, task))["status"] == "COMPLETED"
        assert budgets == [expected]
    finally:
        await runtime.close()
    reopened = create_runtime(directory)
    await reopened.start()
    try:
        assert (await reopened.get_task(task["task_id"]))["max_tool_rounds"] == expected
        next_task = await reopened.create_task({
            "objective": "continue", "workspace_root": str(tmp_path),
            "session_id": task["session_id"], "multi_agent_mode": "off", "max_tool_rounds": 250,
        })
        assert (await finish(reopened, next_task))["status"] == "COMPLETED"
        assert budgets == [expected, 250]
        assert (await reopened.get_task(task["task_id"]))["max_tool_rounds"] == expected
    finally:
        await reopened.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", [0, -1, 1.5, 1001, "100", None, True])
async def test_runtime_rejects_invalid_round_budget(tmp_path: Path, limit: Any) -> None:
    runtime = create_runtime(tmp_path / "data")
    await runtime.start()
    try:
        with pytest.raises(ValueError, match="最大交互轮数"):
            await runtime.create_task({
                "objective": "inspect", "workspace_root": str(tmp_path), "max_tool_rounds": limit,
            })
        assert not runtime._running
        assert (await runtime.list_sessions())["sessions"] == []
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_session_restores_history_memory_and_events_after_restart(
    tmp_path: Path, client: FakeClient
) -> None:
    directory = tmp_path / "data"
    runtime = create_runtime(directory)
    await runtime.start()
    try:
        first = await runtime.create_task(
            {"objective": "remember 73", "workspace_root": str(tmp_path), "multi_agent_mode": "off"}
        )
        assert (await finish(runtime, first))["status"] == "COMPLETED"
        events = await runtime.read_events(first["task_id"])
        assert events
        assert await runtime.read_events(first["task_id"], events[-1]["id"]) == []
    finally:
        await runtime.close()
    reopened = create_runtime(directory)
    await reopened.start()
    try:
        second = await reopened.create_task(
            {
                "objective": "continue",
                "workspace_root": str(tmp_path),
                "session_id": first["session_id"],
                "multi_agent_mode": "auto",
            }
        )
        result = await finish(reopened, second)
        assert result["status"] == "COMPLETED"
        assert "remember 73" in result["result"]["final_answer"]
        assert first["session_id"] == second["session_id"]
        assert first["task_id"] != second["task_id"]
        assert result["result"]["working_memory"]["objective"] == "remember 73"
        detail = await reopened.get_session(first["session_id"])
        assert len(detail["turns"]) == 2
        assert len((await reopened.list_sessions())["sessions"]) == 1
        assert any(item.get("role") == "assistant" for item in client.calls[-1]["input"])
    finally:
        await reopened.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["off", "on", "auto"])
async def test_mode_controls_tools_without_a_separate_router(
    tmp_path: Path, client: FakeClient, mode: str
) -> None:
    runtime = create_runtime(tmp_path / "data")
    await runtime.start()
    try:
        task = await runtime.create_task(
            {"objective": "hello", "workspace_root": str(tmp_path), "multi_agent_mode": mode}
        )
        assert (await finish(runtime, task))["status"] == "COMPLETED"
        assert len(client.calls) == 1
        names = {tool["name"] for tool in client.calls[0]["tools"]}
        assert ("delegate_tasks" in names) == (mode != "off")
        assert (await runtime.get_session(task["session_id"]))["session"][
            "multi_agent_mode"
        ] == mode
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_delegated_agents_cannot_write_or_delegate_recursively(
    tmp_path: Path, client: FakeClient
) -> None:
    runtime = create_runtime(tmp_path / "data")
    await runtime.start()
    try:
        task = await runtime.create_task(
            {
                "objective": "delegate now",
                "workspace_root": str(tmp_path),
                "multi_agent_mode": "auto",
            }
        )
        result = await finish(runtime, task)
        assert result["status"] == "COMPLETED"
        children = [
            call
            for call in client.calls
            if any(
                item.get("content") in {"inspect A", "inspect B"}
                for item in call["input"]
                if isinstance(item.get("content"), str)
            )
        ]
        assert len(children) == 2
        for call in children:
            assert {tool["name"] for tool in call["tools"]} == {
                "read_file",
                "search_code",
                "list_files",
            }
        record = result["result"]["tool_calls"][0]
        assert len(record["output"]["investigations"]) == 2
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_main_runner_can_delegate_more_than_two_batches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    class RepeatedDelegationClient(FakeClient):
        def create(self, **kwargs: Any) -> SimpleNamespace:
            request = to_json_value(kwargs)
            names = {tool["name"] for tool in request["tools"]}
            if "delegate_tasks" in names:
                outputs = [
                    item for item in request["input"]
                    if item.get("type") == "function_call_output"
                ]
                if len(outputs) < 4:
                    self.calls.append(request)
                    batch = len(outputs) + 1
                    call = SimpleNamespace(
                        type="function_call", name="delegate_tasks", call_id=f"batch-{batch}",
                        arguments=json.dumps({"tasks": [{"objective": f"inspect {batch}"}]}),
                    )
                    return SimpleNamespace(output=[call], output_text="")
            return super().create(**kwargs)

    fake = RepeatedDelegationClient()
    monkeypatch.setitem(
        sys.modules, "bit_agent.llm.client", SimpleNamespace(client=fake, model_name="fake")
    )
    runtime = create_runtime(tmp_path / "data")
    await runtime.start()
    try:
        task = await runtime.create_task({
            "objective": "delegate repeatedly", "workspace_root": str(tmp_path),
            "multi_agent_mode": "auto",
        })
        result = await finish(runtime, task)
        assert result["status"] == "COMPLETED"
        records = result["result"]["tool_calls"]
        assert len(records) == 4
        for record in records:
            assert record["tool_name"] == "delegate_tasks"
            assert record["status"] == "SUCCESS"
            assert record["output"]["investigations"][0]["status"] == "COMPLETED"
        assert len(fake.calls) == 9, "five main model requests and four child requests"
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_cancel_before_coroutine_starts_releases_session(
    tmp_path: Path, client: FakeClient
) -> None:
    runtime = create_runtime(tmp_path / "data")
    await runtime.start()
    try:
        task = await runtime.create_task(
            {"objective": "cancel me", "workspace_root": str(tmp_path)}
        )
        runtime._running[task["task_id"]].cancel()
        await runtime.cancel_task(task["task_id"])
        cancelled = await finish(runtime, task)
        assert cancelled["status"] == "CANCELLED"
        assert cancelled["completed_at"]
        again = await runtime.create_task(
            {
                "objective": "try again",
                "workspace_root": str(tmp_path),
                "session_id": task["session_id"],
            }
        )
        assert (await finish(runtime, again))["status"] == "COMPLETED"
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_same_workspace_queues_and_other_workspaces_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entered: list[str] = []
    release = asyncio.Event()

    async def held_runner(prompt: str, **kwargs: Any) -> AgentRunResult:
        entered.append(prompt)
        await release.wait()
        return AgentRunResult(status=AgentRunStatus.COMPLETED, final_answer=prompt, rounds=0)

    monkeypatch.setattr(service, "run_agent", held_runner)
    project = tmp_path / "project"
    project.mkdir()
    other = tmp_path / "other"
    other.mkdir()
    runtime = create_runtime(tmp_path / "data")
    await runtime.start()
    try:
        one = await runtime.create_task({"objective": "one", "workspace_root": str(project)})
        two = await runtime.create_task({"objective": "two", "workspace_root": str(project)})
        three = await runtime.create_task({"objective": "three", "workspace_root": str(other)})
        for _ in range(100):
            if "three" in entered:
                break
            await asyncio.sleep(0.01)
        assert set(entered) == {"one", "three"}
        assert (await runtime.get_task(two["task_id"]))["status"] == "QUEUED"
        release.set()
        for task in (one, two, three):
            assert (await finish(runtime, task))["status"] == "COMPLETED"
    finally:
        release.set()
        await runtime.close()


@pytest.mark.asyncio
async def test_working_memory_has_no_ttl(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path / "data")
    memory_store = SQLiteWorkingMemoryStore(storage)
    await memory_store.save(WorkingMemory(thread_id="stable", objective="keep this"), ttl_seconds=1)
    await asyncio.sleep(1.05)
    assert (await memory_store.load("stable")).objective == "keep this"
    storage.close()


@pytest.mark.asyncio
async def test_invalid_workspace_and_mode_are_rejected(tmp_path: Path) -> None:
    runtime = create_runtime(tmp_path / "data")
    await runtime.start()
    try:
        with pytest.raises(ValueError):
            await runtime.create_task({"objective": "hello", "workspace_root": "relative"})
        with pytest.raises(ValueError):
            await runtime.create_task(
                {"objective": "hello", "workspace_root": str(tmp_path), "multi_agent_mode": "bad"}
            )
        with pytest.raises(ValueError):
            await runtime.create_task(
                {"objective": "hello", "workspace_root": str(tmp_path), "session_id": "missing"}
            )
    finally:
        await runtime.close()
