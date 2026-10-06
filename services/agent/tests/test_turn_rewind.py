"""编辑并重发 / 重新生成：回到最后一轮开始前，撤销它的文件改动、恢复上下文。"""

import asyncio
import json
import sys
from types import SimpleNamespace

import pytest
from bit_agent.runtime.bootstrap import create_runtime
from bit_agent.runtime.domain.errors import InteractionError
from bit_agent.runtime.infrastructure.changes import file_image, write_json


@pytest.fixture
async def runtime(tmp_path, monkeypatch):
    requests: list[list[dict]] = []

    class Responses:
        def create(self, **request):
            requests.append(request["input"])
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
    instance.requests = requests
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


def record_change(runtime, task_id: str, name: str, content: str) -> None:
    """模拟这一轮通过补丁新建了一个文件。"""
    before = file_image(runtime.workspace, name)
    (runtime.workspace / name).write_text(content, encoding="utf-8")
    entry = {
        "id": "change-" + name,
        "call_id": "call",
        "status": "unreviewed",
        "patch": "",
        "files": {name: {"before": before, "after": file_image(runtime.workspace, name)}},
    }
    write_json(runtime.storage.directory / "artifacts" / task_id / "changes.json", [entry])


def mentions(items: list, text: str) -> bool:
    return text in json.dumps(items, ensure_ascii=False)


async def test_edit_last_turn_restores_context_undoes_files_and_continues(runtime):
    first = await run(runtime, "第一轮要求")
    session_id = first["session_id"]
    context_after_first = await runtime.storage.call("load_context", session_id)
    second = await run(runtime, "写错了的第二轮", session_id)
    record_change(runtime, second["task_id"], "new.txt", "由第二轮创建")
    saved = await runtime.get_session(session_id)
    assert saved["rewindable_task_id"] == second["task_id"]

    result = await runtime.rewind_turn(session_id, second["task_id"])

    assert result["objective"] == "写错了的第二轮"
    assert result["undone_files"] == ["new.txt"] and result["session_deleted"] is False
    assert not (runtime.workspace / "new.txt").exists()
    assert await runtime.storage.call("load_context", session_id) == context_after_first
    saved = await runtime.get_session(session_id)
    assert [turn["task_id"] for turn in saved["turns"]] == [first["task_id"]]
    assert await runtime.get_task(second["task_id"]) is None
    assert not (runtime.storage.directory / "artifacts" / second["task_id"]).exists()

    await run(runtime, "改好的第二轮", session_id)
    latest = runtime.requests[-1]
    assert mentions(latest, "改好的第二轮") and mentions(latest, "第一轮要求")
    assert not mentions(latest, "写错了的第二轮")


async def test_rewinding_the_only_turn_deletes_the_conversation(runtime):
    task = await run(runtime, "唯一的一轮")
    result = await runtime.rewind_turn(task["session_id"], task["task_id"])
    assert result["session_deleted"] is True and result["objective"] == "唯一的一轮"
    assert await runtime.get_session(task["session_id"]) is None
    assert (await runtime.list_sessions())["sessions"] == []


async def test_only_the_last_finished_turn_can_be_rewound(runtime):
    first = await run(runtime, "第一轮")
    await run(runtime, "第二轮", first["session_id"])
    with pytest.raises(InteractionError, match="最后一轮"):
        await runtime.rewind_turn(first["session_id"], first["task_id"])
    with pytest.raises(InteractionError):
        await runtime.rewind_turn("other-session", first["task_id"])


async def test_file_edited_after_the_turn_blocks_rewind_without_changing_anything(runtime):
    task = await run(runtime, "改文件的一轮")
    record_change(runtime, task["task_id"], "a.txt", "agent 写的")
    (runtime.workspace / "a.txt").write_text("用户后来又改了", encoding="utf-8")
    context = await runtime.storage.call("load_context", task["session_id"])

    with pytest.raises(InteractionError, match="a.txt"):
        await runtime.rewind_turn(task["session_id"], task["task_id"])

    assert (runtime.workspace / "a.txt").read_text(encoding="utf-8") == "用户后来又改了"
    assert await runtime.get_task(task["task_id"]) is not None
    assert await runtime.storage.call("load_context", task["session_id"]) == context
    assert (await runtime.get_session(task["session_id"]))["rewindable_task_id"] == task["task_id"]
