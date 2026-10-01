"""对话的搜索、重命名和删除。"""

import asyncio
import sys
from types import SimpleNamespace

import pytest
from bit_agent.runtime.bootstrap import create_runtime
from bit_agent.runtime.domain.errors import InteractionError


@pytest.fixture
async def runtime(tmp_path, monkeypatch):
    gate = asyncio.Event()
    gate.set()

    class Responses:
        def create(self, **request):
            prompt = [item for item in request["input"] if item.get("role") == "user"][-1]
            return SimpleNamespace(output=[], output_text=f"ANSWER-FOR {prompt['content']}")

    monkeypatch.setitem(
        sys.modules,
        "bit_agent.llm.client",
        SimpleNamespace(client=SimpleNamespace(responses=Responses()), model_name="fixture"),
    )
    instance = create_runtime(tmp_path / "data")
    await instance.start()
    instance.workspace = tmp_path / "workspace"
    instance.workspace.mkdir()
    yield instance
    await instance.close()


async def run(runtime, objective, session_id=None):
    task = await runtime.create_task(
        {
            "objective": objective,
            "workspace_root": str(runtime.workspace),
            "multi_agent_mode": "off",
            **({"session_id": session_id} if session_id else {}),
        }
    )
    await asyncio.wait_for(runtime._running[task["task_id"]], 10)
    return task


async def test_search_matches_titles_objectives_and_answers(runtime):
    first = await run(runtime, "修复登录页")
    await run(runtime, "补充 100% 覆盖率的测试", first["session_id"])
    other = await run(runtime, "整理 README")

    def ids(result):
        return [session["session_id"] for session in result["sessions"]]

    assert ids(await runtime.list_sessions(query="登录")) == [first["session_id"]]
    # 后续轮次的要求和模型回答也能搜到；% 按普通字符处理。
    assert ids(await runtime.list_sessions(query="100%")) == [first["session_id"]]
    assert ids(await runtime.list_sessions(query="ANSWER-FOR 整理")) == [other["session_id"]]
    assert ids(await runtime.list_sessions(query="不存在的词")) == []
    assert len(ids(await runtime.list_sessions())) == 2


async def test_rename_session(runtime):
    task = await run(runtime, "原来的标题")
    renamed = await runtime.rename_session(task["session_id"], "  新标题  ")
    assert renamed["title"] == "新标题"
    assert (await runtime.list_sessions(query="新标题"))["sessions"][0]["title"] == "新标题"
    with pytest.raises(InteractionError):
        await runtime.rename_session(task["session_id"], " ")
    with pytest.raises(InteractionError):
        await runtime.rename_session("missing", "x")


async def test_delete_session_removes_records_and_artifacts(runtime):
    kept = await run(runtime, "保留的对话")
    task = await run(runtime, "要删除的对话")
    artifacts = runtime.storage.directory / "artifacts" / task["task_id"]
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "changes.json").write_text("[]")

    result = await runtime.delete_session(task["session_id"])
    assert result == {"deleted": True, "session_id": task["session_id"], "tasks": 1}
    assert await runtime.get_session(task["session_id"]) is None
    assert await runtime.get_task(task["task_id"]) is None
    assert await runtime.read_events(task["task_id"]) == []
    assert not artifacts.exists()
    assert await runtime.get_session(kept["session_id"]) is not None
    with pytest.raises(InteractionError):
        await runtime.delete_session(task["session_id"])


async def test_running_session_cannot_be_deleted(runtime):
    runtime._sessions["busy"] = "task"
    with pytest.raises(InteractionError, match="还在执行"):
        await runtime.delete_session("busy")
