"""上下文与任务状态分开保存，旧会话仍能恢复；全部使用临时数据库和假模型。"""

import json
import sqlite3
from types import SimpleNamespace

import pytest
from bit_agent.agent.runtime import run_agent
from bit_agent.context.manager import CONTEXT_SUMMARY_PREFIX, ContextManager
from bit_agent.context.models import ContextSummary
from bit_agent.memory.models import TestStatus as VerificationStatus
from bit_agent.memory.models import WorkingMemory
from bit_agent.observability import InMemoryEventSink
from bit_agent.runtime.bootstrap import create_runtime
from bit_agent.runtime.infrastructure.storage import LocalStorage, SQLiteWorkingMemoryStore

pytestmark = pytest.mark.asyncio


def context_for(summary):
    return {
        "history": [
            {"role": "user", "content": summary.objective},
            {
                "role": "developer",
                "content": CONTEXT_SUMMARY_PREFIX + "\n" + summary.model_dump_json(),
            },
        ]
    }


def legacy_database(directory, *, objective="original goal", intent_objective=None):
    directory.mkdir()
    summary = ContextSummary(objective="original goal", confirmed_facts=["keep this evidence"])
    memory = {
        "thread_id": "session",
        "objective": objective,
        "files_read": ["a.py"],
        "changed_files": ["a.py"],
        "unresolved_errors": ["one error"],
        "history_summary": summary.model_dump_json(),
    }
    context = {
        "history": [{"role": "user", "content": "original goal"}],
        "has_unverified_changes": True,
        "changed_files": ["a.py"],
        "applied_interaction_ids": ["accepted"],
        "intent_state": {
            "objective": intent_objective or objective,
            "constraints": [],
            "current_plan": [],
        },
    }
    with sqlite3.connect(directory / "sessions.sqlite3") as db:
        db.executescript(
            "CREATE TABLE checkpoints (session_id TEXT PRIMARY KEY, data TEXT NOT NULL);"
            "CREATE TABLE working_memory (thread_id TEXT PRIMARY KEY, data TEXT NOT NULL);"
        )
        db.execute("INSERT INTO checkpoints VALUES (?, ?)", ("session", json.dumps(context)))
        db.execute("INSERT INTO working_memory VALUES (?, ?)", ("session", json.dumps(memory)))
    return context, memory


class EmptyProvider:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        pass

    async def model_tools(self):
        return []


class Responses:
    def __init__(self):
        self.inputs = []

    def create(self, **request):
        self.inputs.append(request["input"])
        return SimpleNamespace(output=[], output_text="done")


async def test_separate_records_survive_restart_and_restore_summary(tmp_path):
    summary = ContextSummary(objective="original goal", confirmed_facts=["fact A"])
    memory = WorkingMemory(
        thread_id="session",
        objective="original goal",
        files_read=["a.py"],
        changed_files=["a.py"],
        unresolved_errors=["test failed"],
        has_unverified_changes=True,
        verification_paths=["a.py"],
        applied_interaction_ids=["accepted"],
    )
    storage = LocalStorage(tmp_path / "data")
    try:
        await storage.call("save_progress", "session", context_for(summary), memory)
    finally:
        storage.close()
    reopened = LocalStorage(tmp_path / "data")
    try:
        context = await reopened.call("load_context", "session")
        restored = await SQLiteWorkingMemoryStore(reopened).load("session")
        assert set(context) == {"history"}
        assert restored == memory
        assert "history_summary" not in restored.model_dump()
        manager = ContextManager()
        manager.restore_summary(context["history"])
        assert manager.summary == summary
        tables = {row[0] for row in reopened._db.execute("SELECT name FROM sqlite_master")}
        assert "checkpoints" not in tables
        assert "context_state" in tables
    finally:
        reopened.close()


async def test_legacy_summary_and_progress_move_to_their_owners_once(tmp_path):
    legacy_database(tmp_path / "data")
    storage = LocalStorage(tmp_path / "data")
    try:
        context = await storage.call("load_context", "session")
        memory = await SQLiteWorkingMemoryStore(storage).load("session")
        assert set(context) == {"history"}
        manager = ContextManager()
        manager.restore_summary(context["history"])
        assert manager.summary.confirmed_facts == ["keep this evidence"]
        assert memory.objective == "original goal"
        assert memory.files_read == ["a.py"]
        assert memory.changed_files == ["a.py"]
        assert memory.unresolved_errors == ["one error"]
        assert memory.has_unverified_changes
        assert memory.verification_paths == ["a.py"]
        assert memory.applied_interaction_ids == ["accepted"]
        assert "history_summary" not in json.loads(
            storage._db.execute(
                "SELECT data FROM working_memory WHERE thread_id='session'"
            ).fetchone()[0]
        )
        assert await storage.call("load_context", "session") == context
        assert await SQLiteWorkingMemoryStore(storage).load("session") == memory
    finally:
        storage.close()


async def test_save_failure_rolls_back_both_records(tmp_path):
    storage = LocalStorage(tmp_path / "data")
    memory = WorkingMemory(thread_id="session", objective="before")
    context = {"history": [{"role": "user", "content": "before"}]}
    try:
        await storage.call("save_progress", "session", context, memory)
        storage._db.executescript("""
            CREATE TRIGGER reject_memory BEFORE INSERT ON working_memory
            BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;
        """)
        with pytest.raises(sqlite3.IntegrityError, match="simulated write failure"):
            await storage.call(
                "save_progress",
                "session",
                {"history": [{"role": "user", "content": "after"}]},
                memory.model_copy(update={"objective": "after"}),
            )
        assert await storage.call("load_context", "session") == context
        assert (await storage.call("load_memory", "session")).objective == "before"
    finally:
        storage.close()


async def test_invalid_legacy_memory_is_not_replaced_by_empty_state(tmp_path):
    context, memory = legacy_database(tmp_path / "data", objective="")
    storage = LocalStorage(tmp_path / "data")
    try:
        with pytest.raises(ValueError):
            await storage.call("load_context", "session")
        assert (
            json.loads(
                storage._db.execute(
                    "SELECT data FROM context_state WHERE session_id='session'"
                ).fetchone()[0]
            )
            == context
        )
        assert (
            json.loads(
                storage._db.execute(
                    "SELECT data FROM working_memory WHERE thread_id='session'"
                ).fetchone()[0]
            )
            == memory
        )
    finally:
        storage.close()


async def test_pending_intent_is_not_hidden_by_conflicting_legacy_copy(tmp_path):
    legacy_database(tmp_path / "data", objective="new goal", intent_objective="old goal")
    storage = LocalStorage(tmp_path / "data")
    update = {"id": "accepted", "kind": "replace", "text": "new goal"}
    try:
        await storage.call(
            "create",
            {
                "task_id": "task",
                "session_id": "session",
                "status": "FAILED",
                "created_at": "2026-09-10T00:00:00Z",
                "objective": "original goal",
                "workspace_root": str(tmp_path),
                "multi_agent_mode": "off",
                "intent_updates": [update],
            },
        )
        context = await storage.call("load_context", "session")
        memory = await storage.call("load_memory", "session")
        assert memory.objective == "new goal"
        assert await storage.call("pending_intents", "session") == [update]
        memory.applied_interaction_ids = ["accepted"]
        await storage.call("save_progress", "session", context, memory)
        assert await storage.call("pending_intents", "session") == []
    finally:
        storage.close()


async def test_steered_summary_and_task_state_restore_on_next_run(tmp_path):
    directory = tmp_path / "data"
    summary = ContextSummary(objective="original goal", confirmed_facts=["fact A"])
    memory = WorkingMemory(thread_id="session", objective="original goal", files_read=["a.py"])
    storage = LocalStorage(directory)
    try:
        await storage.call("save_progress", "session", context_for(summary), memory)
    finally:
        storage.close()

    update = {"id": "u1", "kind": "supplement", "text": "Keep API compatible"}
    for _ in range(2):
        storage = LocalStorage(directory)
        responses = Responses()
        manager = ContextManager()

        async def save_progress(context, current_memory, _storage=storage):
            await _storage.call("save_progress", "session", context, current_memory)

        try:
            result = await run_agent(
                "continue",
                thread_id="session",
                workspace_root=tmp_path,
                response_client=SimpleNamespace(responses=responses),
                model_name="fixture",
                tool_provider=EmptyProvider(),
                event_sink=InMemoryEventSink(),
                context_manager=manager,
                working_memory_store=SQLiteWorkingMemoryStore(storage),
                initial_state=await storage.call("load_context", "session"),
                pending_intents=[update],
                save_progress=save_progress,
            )
            assert result.status == "COMPLETED", result.error
            assert result.working_memory.objective == "original goal"
            assert result.working_memory.files_read == ["a.py"]
            assert result.working_memory.constraints == ["Keep API compatible"]
            assert result.working_memory.applied_interaction_ids == ["u1"]
            assert "history_summary" not in result.working_memory.model_dump()
            assert manager.summary.confirmed_facts == ["fact A"]
            assert manager.summary.constraints == ["Keep API compatible"]
            context = await storage.call("load_context", "session")
            assert set(context) == {"history"}
            assert (
                sum(
                    item.get("role") == "user" and "Keep API compatible" in item.get("content", "")
                    for item in context["history"]
                )
                == 1
            )
        finally:
            storage.close()


async def test_undo_updates_task_state_without_mixing_context(tmp_path, monkeypatch):
    runtime = create_runtime(tmp_path / "data")

    class Journal:
        entries = [{"files": ["b.py"]}]

        def __init__(self, *_args):
            pass

        def review(self, change_id, action):
            return {"id": change_id, "action": action}

    monkeypatch.setattr(runtime, "journal_factory", Journal)
    try:
        await runtime.storage.call(
            "create",
            {
                "task_id": "task",
                "session_id": "session",
                "status": "COMPLETED",
                "created_at": "2026-09-10T00:00:00Z",
                "objective": "original goal",
                "workspace_root": str(tmp_path),
                "multi_agent_mode": "off",
            },
        )
        memory = WorkingMemory(
            thread_id="session",
            objective="original goal",
            has_unverified_changes=True,
            verification_paths=["a.py"],
        )
        await runtime.storage.call("save_progress", "session", {"history": []}, memory)
        await runtime.review_change("task", "change", "undo")
        restored = await runtime.memory.load("session")
        assert restored.has_unverified_changes
        assert restored.verification_paths == ["a.py", "b.py"]
        assert restored.latest_test_status == VerificationStatus.NEEDS_VERIFICATION
        context = await runtime.storage.call("load_context", "session")
        assert set(context) == {"history"}
        assert "用户已撤销改动" in context["history"][-1]["content"]
    finally:
        await runtime.close()


async def test_memory_load_failure_never_overwrites_saved_records(tmp_path):
    saved = []

    class BrokenStore:
        async def load(self, thread_id):
            raise RuntimeError("cannot read saved state")

    async def save_progress(context, memory):
        saved.append((context, memory))

    result = await run_agent(
        "continue",
        thread_id="session",
        workspace_root=tmp_path,
        response_client=SimpleNamespace(responses=Responses()),
        model_name="fixture",
        tool_provider=EmptyProvider(),
        event_sink=InMemoryEventSink(),
        working_memory_store=BrokenStore(),
        save_progress=save_progress,
    )
    assert result.status == "FAILED"
    assert "诊断编号：D-" in result.error
    assert "cannot read saved state" not in result.error
    assert saved == []
