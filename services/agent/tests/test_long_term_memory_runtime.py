"""桌面任务接入长期记忆：验收通过后提炼经验，下一次任务召回；可查看、删除、关闭。"""

import asyncio
import os
from pathlib import Path
from typing import Any

import pytest
from bit_agent.agent.result import AgentRunResult, AgentRunStatus
from bit_agent.memory import MemoryCandidate, MemoryKind, WorkingMemory
from bit_agent.runtime import bootstrap
from bit_agent.runtime.application import service
from bit_agent.runtime.application.interaction import InteractionError
from bit_agent.runtime.bootstrap import create_runtime


class StaticExtractor:
    def __init__(self) -> None:
        self.calls = 0

    async def extract(self, evidence):
        self.calls += 1
        assert evidence.independently_verified and evidence.objective == "修复单元测试"
        return [
            MemoryCandidate(
                kind=MemoryKind.PROCEDURE,
                memory_key="project.testing.docker",
                title="单元测试必须在 Docker 中运行",
                content="本项目的单元测试依赖 Docker 沙箱，直接在本机运行会缺少依赖。",
                applicability="本项目的测试任务",
                evidence_summary="独立验收通过",
                importance=0.8,
                confidence=0.9,
            )
        ]


def result(acceptance: str) -> AgentRunResult:
    return AgentRunResult(
        thread_id="t",
        run_id="r",
        status=AgentRunStatus.COMPLETED,
        final_answer="done",
        rounds=1,
        acceptance_status=acceptance,
        working_memory=WorkingMemory(thread_id="t", objective="修复单元测试"),
    )


async def finish(runtime: service.AgentRuntime, task: dict[str, Any]) -> None:
    for _ in range(500):
        current = await runtime.get_task(task["task_id"])
        if current["status"] in service.TERMINAL and task["task_id"] not in runtime._running:
            await asyncio.gather(*runtime._background)
            return
        await asyncio.sleep(0.01)
    raise AssertionError("任务没有按时结束")


@pytest.fixture
def extractor(monkeypatch: pytest.MonkeyPatch) -> StaticExtractor:
    fake = StaticExtractor()
    monkeypatch.setattr(bootstrap, "_memory_extractor", lambda: fake)
    return fake


async def test_accepted_task_is_learned_and_recalled_next_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, extractor: StaticExtractor
) -> None:
    recalled: list[str] = []

    async def runner(prompt: str, **kwargs: Any) -> AgentRunResult:
        context = await kwargs["memory_retriever"].build_context(
            prompt, project_id=kwargs["memory_project_id"]
        )
        recalled.append(context.text)
        return result("PASSED")

    monkeypatch.setattr(service, "run_agent", runner)
    workspace = tmp_path / "Project"
    workspace.mkdir()
    runtime = create_runtime(tmp_path / "data")
    await runtime.start()
    try:
        first = await runtime.create_task(
            {"objective": "修复单元测试", "workspace_root": str(workspace)}
        )
        await finish(runtime, first)
        assert extractor.calls == 1 and recalled == [""]

        # Windows 上同一目录换一种大小写写法仍是同一个项目。
        spelled = str(workspace).upper() if os.name == "nt" else str(workspace)
        listed = await runtime.list_memories(spelled)
        assert listed["enabled"] is True
        assert [item["memory_key"] for item in listed["memories"]] == ["project.testing.docker"]
        assert "embedding" not in listed["memories"][0]

        second = await runtime.create_task(
            {"objective": "单元测试又失败了", "workspace_root": str(workspace)}
        )
        await finish(runtime, second)
        assert "Docker" in recalled[-1]

        memory_id = listed["memories"][0]["id"]
        assert await runtime.delete_memory(memory_id) == {"deleted": True, "memory_id": memory_id}
        assert (await runtime.list_memories(str(workspace)))["memories"] == []
        with pytest.raises(InteractionError):
            await runtime.delete_memory(memory_id)
    finally:
        await runtime.close()


async def test_task_without_independent_acceptance_is_not_learned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, extractor: StaticExtractor
) -> None:
    async def runner(prompt: str, **kwargs: Any) -> AgentRunResult:
        return result("NOT_RUN")

    monkeypatch.setattr(service, "run_agent", runner)
    runtime = create_runtime(tmp_path / "data")
    await runtime.start()
    try:
        task = await runtime.create_task(
            {"objective": "修复单元测试", "workspace_root": str(tmp_path)}
        )
        await finish(runtime, task)
        assert extractor.calls == 0
        assert (await runtime.list_memories(str(tmp_path)))["memories"] == []
    finally:
        await runtime.close()


async def test_long_term_memory_can_be_switched_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, extractor: StaticExtractor
) -> None:
    seen: list[Any] = []

    async def runner(prompt: str, **kwargs: Any) -> AgentRunResult:
        seen.append(kwargs["memory_retriever"])
        return result("PASSED")

    monkeypatch.setattr(service, "run_agent", runner)
    monkeypatch.setenv("BIT_AGENT_LONG_TERM_MEMORY", "0")
    runtime = create_runtime(tmp_path / "data")
    await runtime.start()
    try:
        task = await runtime.create_task(
            {"objective": "修复单元测试", "workspace_root": str(tmp_path)}
        )
        await finish(runtime, task)
        assert seen == [None] and extractor.calls == 0
        assert await runtime.list_memories() == {"enabled": False, "memories": []}
        assert not (tmp_path / "data" / "long_term_memory.sqlite3").exists()
    finally:
        await runtime.close()
