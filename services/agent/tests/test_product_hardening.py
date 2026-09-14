"""用本地替身验收交互、权限和撤销，不调用付费模型，不碰日常会话。"""

import asyncio
import json
from pathlib import Path

import pytest
from bit_agent.observability import InMemoryEventSink
from bit_agent.runtime.application.capacity import ExecutionSlot
from bit_agent.runtime.application.delegation import DelegatingToolProvider
from bit_agent.runtime.application.interaction import (
    InteractionError,
    QuestionOption,
    TaskInteraction,
    UserQuestion,
)
from bit_agent.runtime.infrastructure.changes import ChangeJournal
from bit_agent.runtime.infrastructure.storage import LocalStorage
from bit_agent.runtime.infrastructure.verification import verification_plan, verify_project
from bit_agent.tools.models import ToolStatus


def question(**changes) -> UserQuestion:
    return UserQuestion(
        question="选择实现方案",
        options=[
            QuestionOption(id="a", label="简单实现", description="改动较少"),
            QuestionOption(id="b", label="完整实现", description="改动较多"),
        ],
        recommended_option_id="a",
        requires_confirmation=changes.get("confirm", False),
    )


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
            "created_at": "2026-09-09T00:00:00Z",
            "updated_at": "2026-09-09T00:00:00Z",
            "started_at": "2026-09-09T00:00:00Z",
            "completed_at": None,
            "worker_id": "local",
            "run_id": None,
            "result": None,
            "error": None,
        },
    )
    return TaskInteraction(storage, "task")


async def until(predicate) -> None:
    for _ in range(200):
        if predicate():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("等待状态超时")


async def test_pause_releases_slot_and_resume_reacquires(tmp_path):
    interaction = await control(tmp_path)
    slots = asyncio.Semaphore(1)

    async def work():
        async with ExecutionSlot(slots) as slot:
            interaction.slot = slot
            await interaction.request({"action": "pause"})
            return await interaction.boundary()

    operation = asyncio.create_task(work())
    await until(lambda: interaction.pause_requested and slots._value == 1)
    await slots.acquire()
    await interaction.request({"action": "resume"})
    await asyncio.sleep(0.01)
    assert not operation.done()
    slots.release()
    assert await operation == []
    assert slots._value == 1
    interaction.storage.close()


async def test_question_defaults_and_stale_reply_rejected(tmp_path):
    interaction = await control(tmp_path)
    request = question().model_copy(update={"timeout_seconds": 0})
    result = await interaction.ask(request)
    assert result["source"] == "timeout" and result["option_id"] == "a"
    assert not result["permission_granted"]
    with pytest.raises(InteractionError):
        await interaction.request(
            {"action": "answer", "question_id": result["question_id"], "option_id": "b"}
        )
    interaction.storage.close()


async def test_sensitive_question_never_defaults_and_intent_interrupts(tmp_path):
    interaction = await control(tmp_path)
    pending = asyncio.create_task(
        interaction.ask(question(confirm=True).model_copy(update={"timeout_seconds": 0}))
    )
    await until(lambda: interaction.question is not None)
    await asyncio.sleep(0.03)
    assert not pending.done()
    await interaction.request({"action": "replace", "text": "不要再写代码"})
    assert (await pending)["source"] == "intent_changed"
    assert (await interaction.boundary())[0]["kind"] == "replace"
    interaction.storage.close()


PATCH = "*** Begin Patch\n*** Add File: demo.py\n+print('hello')\n*** End Patch\n"


async def test_readonly_blocks_tool_without_writing(tmp_path):
    provider = DelegatingToolProvider(
        tmp_path, "off", InMemoryEventSink(), tmp_path / "artifacts", permission_mode="read_only",
        journal=ChangeJournal(tmp_path, tmp_path / "artifacts"), verifier=verify_project,
    )
    result = await provider.call_tool("apply_patch", "call", json.dumps({"patch": PATCH}))
    assert result.error.code == "PERMISSION_DENIED"
    assert not (tmp_path / "demo.py").exists()


async def test_confirm_requires_exact_explicit_approval_and_tracks_patch(tmp_path):
    interaction = await control(tmp_path)
    provider = DelegatingToolProvider(
        tmp_path, "off", InMemoryEventSink(), tmp_path / "artifacts", interaction,
        journal=ChangeJournal(tmp_path, tmp_path / "artifacts"), verifier=verify_project,
    )
    pending = asyncio.create_task(
        provider.call_tool("apply_patch", "call", json.dumps({"patch": PATCH}))
    )
    await until(lambda: interaction.question is not None)
    assert not (tmp_path / "demo.py").exists()
    assert "demo.py" in interaction.question["operation"]["detail"]
    await interaction.request(
        {"action": "answer", "question_id": interaction.question["id"], "option_id": "approve"}
    )
    result = await pending
    assert result.status is ToolStatus.SUCCESS, result
    assert len(provider.journal.public()["changes"]) == 1
    interaction.storage.close()


def test_undo_refuses_user_changes_and_restores_original(tmp_path):
    file = tmp_path / "demo.py"
    file.write_text("old\n")
    journal = ChangeJournal(tmp_path, tmp_path / "artifacts")
    patch = "*** Begin Patch\n*** Update File: demo.py\n@@\n-old\n+new\n*** End Patch\n"
    entry = journal.prepare("call", patch)
    journal.begin(entry)
    file.write_text("new\n")
    journal.finish(entry)
    file.write_text("user edit\n")
    with pytest.raises(InteractionError):
        journal.review(entry["id"], "undo")
    assert file.read_text() == "user edit\n"
    file.write_text("new\n")
    journal.review(entry["id"], "undo")
    assert file.read_text() == "old\n"
    assert (
        ChangeJournal(tmp_path, tmp_path / "artifacts").public()["changes"][0]["status"] == "undone"
    )


def test_frontend_verification_is_not_pytest(tmp_path):
    (tmp_path / "package.json").write_text(
        json.dumps(
            {"scripts": {"test": "vitest run", "typecheck": "tsc --noEmit", "build": "vite build"}}
        )
    )
    plan = verification_plan(tmp_path, ["src/main.ts"])
    assert plan[0]["language"] == "node"
    assert plan[0]["commands"] == [["npm", "run", name] for name in ("test", "typecheck", "build")]


async def test_missing_tests_cannot_pass_verification(tmp_path):
    result = await verify_project(tmp_path, ["new.ts"], "call")
    assert result.status is not ToolStatus.SUCCESS
    assert result.output["verified"] is False


def test_pending_journal_cannot_be_automatically_undone(tmp_path):
    journal = ChangeJournal(tmp_path, tmp_path / "artifacts")
    entry = journal.prepare("call", PATCH)
    journal.begin(entry)
    with pytest.raises(InteractionError):
        journal.review(entry["id"], "undo")


async def test_cancelling_question_does_not_leak_execution_slot(tmp_path):
    interaction = await control(tmp_path)
    semaphore = asyncio.Semaphore(1)

    async def work():
        async with ExecutionSlot(semaphore) as slot:
            interaction.slot = slot
            await interaction.ask(question(confirm=True))

    task = asyncio.create_task(work())
    await until(lambda: interaction.question is not None)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert semaphore._value == 1
    interaction.close()
    interaction.storage.close()


def test_symlink_cannot_bypass_secret_path_rule(tmp_path):
    from bit_agent.security.paths import PathSecurityError, resolve_workspace_path

    secret = tmp_path / ".env"
    secret.write_text("SECRET=fixture")
    alias = tmp_path / "ordinary.txt"
    try:
        alias.symlink_to(secret)
    except OSError:
        pytest.skip("当前用户不能创建符号链接")
    with pytest.raises(PathSecurityError):
        resolve_workspace_path(tmp_path, "ordinary.txt")


async def test_user_edit_during_approval_prevents_write(tmp_path):
    interaction = await control(tmp_path)
    provider = DelegatingToolProvider(
        tmp_path, "off", InMemoryEventSink(), tmp_path / "artifacts", interaction,
        journal=ChangeJournal(tmp_path, tmp_path / "artifacts"), verifier=verify_project,
    )
    pending = asyncio.create_task(
        provider.call_tool("apply_patch", "call", json.dumps({"patch": PATCH}))
    )
    await until(lambda: interaction.question is not None)
    (tmp_path / "demo.py").write_text("user created this\n")
    await interaction.request(
        {"action": "answer", "question_id": interaction.question["id"], "option_id": "approve"}
    )
    result = await pending
    assert result.status is not ToolStatus.SUCCESS
    assert (tmp_path / "demo.py").read_text() == "user created this\n"
    interaction.storage.close()
