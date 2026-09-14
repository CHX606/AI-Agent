"""调查分工不设累计批次上限，但跨调用共享并发名额。"""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from bit_agent.agent.result import AgentRunResult, AgentRunStatus
from bit_agent.observability import InMemoryEventSink
from bit_agent.runtime.application import delegation
from bit_agent.runtime.application.delegation import DelegatingToolProvider
from bit_agent.runtime.infrastructure.changes import ChangeJournal
from bit_agent.runtime.infrastructure.verification import verify_project
from bit_agent.tools.models import ToolStatus


def make_provider(root: Path, mode: str = "auto") -> DelegatingToolProvider:
    return DelegatingToolProvider(
        root, mode, InMemoryEventSink(), root / "artifacts",
        journal=ChangeJournal(root, root / "journal"), verifier=verify_project,
    )


@pytest.fixture
def provider(tmp_path):
    return make_provider(tmp_path)


def completed():
    return AgentRunResult(status=AgentRunStatus.COMPLETED, final_answer="调查完成", rounds=1)


async def invoke(provider, objectives, call_id="delegate"):
    return await provider.call_tool(
        "delegate_tasks", call_id,
        json.dumps({"tasks": [{"objective": objective} for objective in objectives]}),
    )


class BlockingRunner:
    def __init__(self):
        self.release = asyncio.Event()
        self.started = asyncio.Queue()
        self.objectives = []
        self.active = 0
        self.peak = 0

    async def __call__(self, objective, **kwargs):
        self.objectives.append(objective)
        self.active += 1
        self.peak = max(self.peak, self.active)
        self.started.put_nowait(objective)
        try:
            await self.release.wait()
            return completed()
        finally:
            self.active -= 1

    async def wait_started(self, count):
        for _ in range(count):
            await asyncio.wait_for(self.started.get(), timeout=3)


@pytest.mark.parametrize("mode", ["on", "auto"])
@pytest.mark.parametrize("permission", ["read_only", "confirm", "edit"])
async def test_repeated_batches_keep_read_only_tools_and_child_round_limit(
    provider, monkeypatch, mode, permission,
):
    runner = AsyncMock(return_value=completed())
    monkeypatch.setattr(delegation, "run_agent", runner)
    provider.mode = mode
    provider.permission_mode = permission

    for batch in range(10):
        result = await invoke(provider, [f"batch-{batch}-{i}" for i in range(3)])
        assert result.status is ToolStatus.SUCCESS
        assert len(result.output["investigations"]) == 3

    assert runner.await_count == 30
    identifiers = set()
    for call in runner.await_args_list:
        assert call.kwargs["max_tool_rounds"] == 8
        assert call.kwargs["workspace_root"] == provider.root
        tools = await call.kwargs["tool_provider"].model_tools()
        assert {tool["name"] for tool in tools} == {"list_files", "read_file", "search_code"}
        identifiers.add(call.kwargs["agent_id"])
    assert len(identifiers) == 30


async def test_overlapping_batches_share_three_slots(provider, monkeypatch):
    runner = BlockingRunner()
    monkeypatch.setattr(delegation, "run_agent", runner)
    calls = [asyncio.create_task(invoke(provider, ["a", "b"], "first"))]
    try:
        await runner.wait_started(2)
        calls.append(asyncio.create_task(invoke(provider, ["c", "d", "e"], "second")))
        await runner.wait_started(1)
        assert runner.active == 3
        runner.release.set()
        results = await asyncio.wait_for(asyncio.gather(*calls), timeout=3)
        assert all(result.status is ToolStatus.SUCCESS for result in results)
        assert [item["objective"] for item in results[1].output["investigations"]] == [
            "c", "d", "e",
        ]
        assert runner.peak == 3
        assert len(runner.objectives) == 5
        assert runner.active == 0
    finally:
        runner.release.set()
        for call in calls:
            call.cancel()
        await asyncio.gather(*calls, return_exceptions=True)


async def test_different_main_tasks_have_independent_slots(tmp_path, monkeypatch):
    runner = BlockingRunner()
    monkeypatch.setattr(delegation, "run_agent", runner)
    first = make_provider(tmp_path / "first")
    second = make_provider(tmp_path / "second")
    calls = [
        asyncio.create_task(invoke(first, ["a", "b", "c"])),
        asyncio.create_task(invoke(second, ["d", "e", "f"])),
    ]
    try:
        await runner.wait_started(6)
        assert runner.active == 6
        runner.release.set()
        await asyncio.wait_for(asyncio.gather(*calls), timeout=3)
        assert runner.active == 0
    finally:
        runner.release.set()
        for call in calls:
            call.cancel()
        await asyncio.gather(*calls, return_exceptions=True)


async def test_child_failures_release_slots_for_later_batches(provider, monkeypatch):
    runner = AsyncMock(side_effect=[RuntimeError("fixture failure")] * 3 + [completed()] * 3)
    monkeypatch.setattr(delegation, "run_agent", runner)
    failed = await invoke(provider, ["a", "b", "c"])
    assert all(item["status"] == "FAILED" for item in failed.output["investigations"])
    recovered = await asyncio.wait_for(invoke(provider, ["d", "e", "f"]), timeout=3)
    assert all(item["status"] == "COMPLETED" for item in recovered.output["investigations"])
    assert runner.await_count == 6


@pytest.mark.parametrize("cancel_running", [False, True])
async def test_cancelling_running_or_waiting_batch_does_not_leak_slots(
    provider, monkeypatch, cancel_running,
):
    runner = BlockingRunner()
    monkeypatch.setattr(delegation, "run_agent", runner)
    running = asyncio.create_task(invoke(provider, ["a", "b", "c"], "running"))
    calls = [running]
    try:
        await runner.wait_started(3)
        waiting = asyncio.create_task(invoke(provider, ["d", "e", "f"], "waiting"))
        calls.append(waiting)
        # 调用先创建子协程，下一次调度让它们进入信号量等待。
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert runner.active == 3
        cancelled, survivor = (running, waiting) if cancel_running else (waiting, running)
        cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled
        if cancel_running:
            await runner.wait_started(3)
        runner.release.set()
        assert (await asyncio.wait_for(survivor, timeout=3)).status is ToolStatus.SUCCESS
        assert runner.active == 0
        assert len(runner.objectives) == (6 if cancel_running else 3)
        result = await asyncio.wait_for(invoke(provider, ["g", "h", "i"]), timeout=3)
        assert result.status is ToolStatus.SUCCESS
        assert runner.peak == 3
        assert runner.active == 0
    finally:
        runner.release.set()
        for call in calls:
            call.cancel()
        await asyncio.gather(*calls, return_exceptions=True)


async def test_timeout_cancels_children_and_releases_slots(provider, monkeypatch):
    runner = BlockingRunner()
    monkeypatch.setattr(delegation, "run_agent", runner)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(invoke(provider, ["a", "b", "c"]), timeout=0.1)
    assert len(runner.objectives) == 3
    assert runner.active == 0
    runner.release.set()
    result = await asyncio.wait_for(invoke(provider, ["d", "e", "f"]), timeout=3)
    assert result.status is ToolStatus.SUCCESS


@pytest.mark.parametrize("payload", [
    {"tasks": []},
    {"tasks": [{"objective": str(i)} for i in range(4)]},
    {"tasks": [{"objective": " "}]},
    {"tasks": [{"objective": "a" * 4001}]},
    {"tasks": [{"objective": "inspect", "tools": ["apply_patch"]}]},
    {"tasks": [{"objective": "inspect"}], "limit": 10},
])
async def test_invalid_arguments_do_not_start_children(provider, monkeypatch, payload):
    runner = AsyncMock(return_value=completed())
    monkeypatch.setattr(delegation, "run_agent", runner)
    result = await provider.call_tool("delegate_tasks", "invalid", json.dumps(payload))
    assert result.status is ToolStatus.ERROR
    assert result.error.code == "INVALID_ARGUMENT"
    runner.assert_not_awaited()


async def test_off_mode_still_hides_and_rejects_delegation(provider, monkeypatch):
    runner = AsyncMock(return_value=completed())
    monkeypatch.setattr(delegation, "run_agent", runner)
    provider.mode = "off"
    assert "delegate_tasks" not in {tool["name"] for tool in await provider.model_tools()}
    result = await invoke(provider, ["inspect"])
    assert result.status is ToolStatus.ERROR
    assert result.error.code == "DELEGATION_LIMIT"
    runner.assert_not_awaited()
