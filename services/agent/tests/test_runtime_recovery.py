"""重叠目录调度和已接收回答的恢复；仅使用临时目录与模型替身。"""

import asyncio
import json
import sys
from types import SimpleNamespace

import pytest
from bit_agent.agent.result import AgentRunResult, AgentRunStatus
from bit_agent.context.serialization import to_json_value
from bit_agent.memory.models import WorkingMemory
from bit_agent.runtime.application import service
from bit_agent.runtime.application.capacity import ExecutionSlot
from bit_agent.runtime.application.interaction import (
    InteractionError,
    QuestionOption,
    TaskInteraction,
    UserQuestion,
)
from bit_agent.runtime.bootstrap import create_runtime
from bit_agent.runtime.infrastructure.storage import LocalStorage


async def until(predicate):
    async with asyncio.timeout(5):
        while not predicate():
            await asyncio.sleep(0.005)


async def finished(runtime, task):
    await until(lambda: task["task_id"] not in runtime._running)
    return await runtime.get_task(task["task_id"])


def task_record(root, **changes):
    return {
        "task_id": "task", "session_id": "session", "multi_agent_mode": "off",
        "objective": "build a UI", "workspace_root": str(root), "status": "RUNNING",
        "created_at": "2026-09-12T00:00:00+00:00",
        "updated_at": "2026-09-12T00:00:00+00:00",
        "started_at": "2026-09-12T00:00:00+00:00", "completed_at": None,
        "worker_id": "local", "run_id": None, "result": None, "error": None,
        **changes,
    }


def question(*, confirmation=False):
    return UserQuestion(
        question="Which color?",
        options=[QuestionOption(id="red", label="Red", description="Red UI"),
                 QuestionOption(id="blue", label="Blue", description="Blue UI")],
        recommended_option_id="blue", requires_confirmation=confirmation,
    )


@pytest.mark.parametrize("parent_first", [True, False])
async def test_overlapping_workspaces_queue_and_cancel_without_blocking_siblings(
    tmp_path, monkeypatch, parent_first
):
    parent = tmp_path / "project"
    child = parent / "src"
    child.mkdir(parents=True)
    other = tmp_path / "other"
    other.mkdir()
    entered = []
    release = asyncio.Event()

    async def runner(prompt, **kwargs):
        entered.append(prompt)
        if prompt == "first":
            await release.wait()
        return AgentRunResult(status=AgentRunStatus.COMPLETED, final_answer=prompt, rounds=0)

    monkeypatch.setattr(service, "run_agent", runner)
    runtime = create_runtime(tmp_path / "data")
    await runtime.start()
    first_root, second_root = (parent, child) if parent_first else (child, parent)
    try:
        first = await runtime.create_task({"objective": "first", "workspace_root": str(first_root)})
        await until(lambda: "first" in entered)
        queued = await runtime.create_task(
            {"objective": "queued", "workspace_root": str(second_root)}
        )
        sibling = await runtime.create_task({"objective": "sibling", "workspace_root": str(other)})
        assert (await finished(runtime, sibling))["status"] == "COMPLETED"
        assert entered == ["first", "sibling"]
        assert (await runtime.get_task(queued["task_id"]))["status"] == "QUEUED"
        await runtime.cancel_task(queued["task_id"])
        assert (await finished(runtime, queued))["status"] == "CANCELLED"
        next_task = await runtime.create_task(
            {"objective": "next", "workspace_root": str(second_root)}
        )
        release.set()
        assert (await finished(runtime, first))["status"] == "COMPLETED"
        assert (await finished(runtime, next_task))["status"] == "COMPLETED"
        assert entered == ["first", "sibling", "next"]
        assert not runtime._workspaces._active and not runtime._workspaces._waiting
        assert runtime._slots._value == 2
    finally:
        release.set()
        await runtime.close()


async def test_waiting_user_retains_overlap_reservation_but_releases_execution_slot(
    tmp_path, monkeypatch
):
    parent = tmp_path / "project"
    child = parent / "src"
    child.mkdir(parents=True)
    other = tmp_path / "other"
    other.mkdir()
    entered = []

    async def runner(prompt, **kwargs):
        entered.append(prompt)
        if prompt == "first":
            await kwargs["tool_provider"].interaction.ask(question())
        return AgentRunResult(status=AgentRunStatus.COMPLETED, final_answer=prompt, rounds=0)

    monkeypatch.setattr(service, "run_agent", runner)
    runtime = create_runtime(tmp_path / "data", concurrency=1)
    await runtime.start()
    try:
        first = await runtime.create_task({"objective": "first", "workspace_root": str(parent)})
        control = runtime._interactions[first["task_id"]]
        await until(lambda: control.question is not None and runtime._slots._value == 1)
        second = await runtime.create_task({"objective": "second", "workspace_root": str(child)})
        sibling = await runtime.create_task({"objective": "sibling", "workspace_root": str(other)})
        assert (await finished(runtime, sibling))["status"] == "COMPLETED"
        assert entered == ["first", "sibling"]
        await runtime.interact_task(first["task_id"], {
            "action": "answer", "question_id": control.question["id"], "option_id": "red",
        })
        assert (await finished(runtime, first))["status"] == "COMPLETED"
        assert (await finished(runtime, second))["status"] == "COMPLETED"
    finally:
        await runtime.close()


@pytest.mark.parametrize("active_parent", [True, False])
@pytest.mark.parametrize("action", ["accept", "undo"])
async def test_review_respects_overlapping_active_workspace(tmp_path, active_parent, action):
    parent = tmp_path / "project"
    child = parent / "src"
    child.mkdir(parents=True)
    active, reviewed = (parent, child) if active_parent else (child, parent)
    runtime = create_runtime(tmp_path / "data")
    calls = []

    class Journal:
        entries = [{"files": ["file.txt"]}]

        def review(self, change_id, selected):
            calls.append((change_id, selected))
            return {"id": change_id, "action": selected}

    runtime.journal_factory = lambda *_: Journal()
    await runtime.start()
    try:
        await runtime.storage.call("create", task_record(reviewed, status="COMPLETED"))
        async with runtime._workspaces.hold(active):
            with pytest.raises(InteractionError, match="工作区还有任务"):
                await runtime.review_change("task", "change", action)
        assert calls == []
        assert (await runtime.review_change("task", "change", action))["action"] == action
        assert calls == [("change", action)]
    finally:
        await runtime.close()


class Responses:
    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(to_json_value(kwargs))
        message = SimpleNamespace(type="message", role="assistant", content=[
            {"type": "output_text", "text": "Done", "annotations": []},
        ])
        return SimpleNamespace(output=[message], output_text="Done")


async def test_accepted_answer_survives_slot_wait_interruption_and_is_applied_once(
    tmp_path, monkeypatch
):
    directory = tmp_path / "data"
    storage = LocalStorage(directory)
    await storage.call("create", task_record(tmp_path))
    control = TaskInteraction(storage, "task")
    semaphore = asyncio.Semaphore(1)

    async def ask():
        async with ExecutionSlot(semaphore) as slot:
            control.slot = slot
            return await control.ask(question())

    asking = asyncio.create_task(ask())
    await until(lambda: control.question is not None and semaphore._value == 1)
    await semaphore.acquire()
    await control.request({
        "action": "answer", "question_id": control.question["id"],
        "text": "Please use red, never blue.",
    })
    await asyncio.sleep(0.01)
    assert not asking.done()
    asking.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asking
    control.close()
    storage.close()

    responses = Responses()
    monkeypatch.setitem(sys.modules, "bit_agent.llm.client", SimpleNamespace(
        client=SimpleNamespace(responses=responses), model_name="fixture",
    ))
    runtime = create_runtime(directory)
    await runtime.start()
    try:
        detail = await runtime.get_session("session")
        assert "Please use red, never blue." in detail["turns"][0]["intent_updates"][0]["text"]
        for prompt in ("continue", "continue again"):
            task = await runtime.create_task({
                "objective": prompt, "workspace_root": str(tmp_path),
                "session_id": "session", "multi_agent_mode": "off",
            })
            assert (await finished(runtime, task))["status"] == "COMPLETED"
            assert await runtime.storage.call("pending_intents", "session") == []
            users = [item.get("content", "") for item in responses.calls[-1]["input"]
                     if item.get("role") == "user"]
            assert sum("Please use red, never blue." in content for content in users) == 1
    finally:
        await runtime.close()


async def test_normal_answer_is_not_replayed_after_history_compaction(tmp_path):
    storage = LocalStorage(tmp_path / "data")
    await storage.call("create", task_record(tmp_path))
    control = TaskInteraction(storage, "task")
    asking = asyncio.create_task(control.ask(question()))
    try:
        await until(lambda: control.question is not None)
        await control.request({
            "action": "answer", "question_id": control.question["id"], "option_id": "red",
        })
        answer = await asking
        assert len(await storage.call("pending_intents", "session")) == 1
        history = [{"type": "function_call_output", "call_id": "call", "output": json.dumps({
            "tool_name": "ask_user", "status": "SUCCESS", "output": answer,
        })}]
        memory = WorkingMemory(thread_id="session", objective="build a UI")
        await storage.call("save_progress", "session", {"history": history}, memory)
        assert await storage.call("pending_intents", "session") == []
        await storage.call("save_progress", "session", {"history": []}, memory)
        assert await storage.call("pending_intents", "session") == []
    finally:
        control.close()
        storage.close()
    reopened = LocalStorage(tmp_path / "data")
    try:
        assert await reopened.call("pending_intents", "session") == []
    finally:
        reopened.close()


async def test_answer_acknowledgement_rolls_back_with_context(tmp_path, monkeypatch):
    storage = LocalStorage(tmp_path / "data")
    await storage.call("create", task_record(tmp_path))
    control = TaskInteraction(storage, "task")
    asking = asyncio.create_task(control.ask(question()))
    try:
        await until(lambda: control.question is not None)
        await control.request({
            "action": "answer", "question_id": control.question["id"], "option_id": "red",
        })
        await asking
        pending = await storage.call("pending_intents", "session")
        memory = WorkingMemory(
            thread_id="session", objective="build a UI", applied_interaction_ids=[pending[0]["id"]],
        )
        original_acknowledge = storage._acknowledge_answers

        def fail_after_acknowledgement(*args):
            original_acknowledge(*args)
            raise OSError("simulated interrupted transaction")

        monkeypatch.setattr(storage, "_acknowledge_answers", fail_after_acknowledgement)
        with pytest.raises(OSError, match="interrupted transaction"):
            await storage.call("save_progress", "session", {"history": [
                {"role": "user", "content": pending[0]["text"]},
            ]}, memory)
        assert await storage.call("load_context", "session") == {"history": []}
        assert await storage.call("load_memory", "session") is None
        assert await storage.call("pending_intents", "session") == pending
    finally:
        control.close()
        storage.close()


async def test_recovered_answers_keep_order_with_later_goal_replacement(tmp_path):
    storage = LocalStorage(tmp_path / "data")
    await storage.call("create", task_record(tmp_path))
    control = TaskInteraction(storage, "task")
    asking = asyncio.create_task(control.ask(question()))
    try:
        await until(lambda: control.question is not None)
        await control.request({
            "action": "answer", "question_id": control.question["id"], "option_id": "red",
        })
        await asking
        await control.request({"action": "pause"})
        boundary = asyncio.create_task(control.boundary())
        async with asyncio.timeout(5):
            while (await storage.call("get_task", "task"))["status"] != "PAUSED":
                await asyncio.sleep(0.005)
        await control.request({"action": "replace", "text": "Build a CLI instead"})
        await boundary
        pending = await storage.call("pending_intents", "session")
        assert [update["kind"] for update in pending] == ["supplement", "replace"]
        assert "Red UI" in pending[0]["text"]
        assert pending[1]["text"] == "Build a CLI instead"
    finally:
        control.close()
        storage.close()


@pytest.mark.parametrize("confirmation,operation", [(True, None), (False, {"title": "write"})])
async def test_approval_answers_never_enter_recovery_queue(tmp_path, confirmation, operation):
    storage = LocalStorage(tmp_path / "data")
    await storage.call("create", task_record(tmp_path))
    control = TaskInteraction(storage, "task")
    asking = asyncio.create_task(
        control.ask(question(confirmation=confirmation), operation=operation)
    )
    try:
        await until(lambda: control.question is not None)
        await control.request({
            "action": "answer", "question_id": control.question["id"], "option_id": "red",
        })
        assert (await asking)["source"] == "user"
        assert await storage.call("pending_intents", "session") == []
        assert (await storage.call("get_task", "task"))["last_answer"] is not None
    finally:
        control.close()
        storage.close()
