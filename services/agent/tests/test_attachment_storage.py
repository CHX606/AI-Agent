"""Attachment history, recovery, rewind and input limits preserve original files."""

import asyncio
import json

import pytest
from bit_agent.agent.runtime import run_agent
from bit_agent.images import user_message
from bit_agent.memory import WorkingMemory
from bit_agent.runtime.application.acceptance_input import acceptance_input
from bit_agent.runtime.application.interaction import InteractionError, TaskInteraction
from bit_agent.runtime.application.interaction_requests import message_input
from bit_agent.runtime.application.task_submission import _task_input
from bit_agent.runtime.bootstrap import create_runtime
from bit_agent.runtime.infrastructure.storage import LocalStorage
from test_attachment_sdk import FILE, TEXT, sdk_text
from test_image_inputs import IMAGE
from test_image_sdk import ModelEndpoint, configure_client, finished
from test_runtime_recovery import question, task_record, until


@pytest.mark.parametrize("api", ["responses", "chat_completions"])
async def test_attachment_survives_restart_continuation_and_rewind(tmp_path, monkeypatch, api):
    endpoint, directory = ModelEndpoint(api), tmp_path / "state"
    async with endpoint.client() as client:
        configure_client(monkeypatch, client, api)
        runtime = create_runtime(directory)
        await runtime.start()
        try:
            first = await runtime.create_task(
                {
                    "objective": "",
                    "attachments": [FILE],
                    "workspace_root": str(tmp_path),
                    "multi_agent_mode": "off",
                }
            )
            await finished(runtime, first)
        finally:
            await runtime.close()
        reopened = create_runtime(directory)
        await reopened.start()
        try:
            detail = await reopened.get_session(first["session_id"])
            assert detail["session"]["title"] == "请查看上传的附件。"
            assert detail["turns"][0]["attachments"] == [FILE]
            before = await reopened.storage.call("load_context", first["session_id"])
            second = await reopened.create_task(
                {
                    "objective": "read again",
                    "attachments": [FILE],
                    "workspace_root": str(tmp_path),
                    "session_id": first["session_id"],
                    "multi_agent_mode": "off",
                }
            )
            await finished(reopened, second)
            assert sdk_text(endpoint).count(TEXT) == 2
            result = await reopened.rewind_turn(first["session_id"], second["task_id"])
            assert result["attachments"] == [FILE]
            assert await reopened.storage.call("load_context", first["session_id"]) == before
            third = await reopened.create_task(
                {
                    "objective": result["objective"],
                    "attachments": result["attachments"],
                    "workspace_root": result["workspace_root"],
                    "session_id": first["session_id"],
                    "multi_agent_mode": "off",
                }
            )
            await finished(reopened, third)
            assert sdk_text(endpoint).count(TEXT) == 2
        finally:
            await reopened.close()


async def test_unconsumed_attachment_answer_replays_exactly_once(tmp_path, monkeypatch):
    directory = tmp_path / "state"
    storage = LocalStorage(directory)
    await storage.call("create", task_record(tmp_path))
    control = TaskInteraction(storage, "task")
    asking = asyncio.create_task(control.ask(question()))
    await until(lambda: control.question is not None)
    await control.request(
        {
            "action": "answer",
            "question_id": control.question["id"],
            "text": "",
            "attachments": [FILE],
        }
    )
    answer = await asking
    assert answer["attachments"] == [
        {
            "name": FILE["name"],
            "mime_type": FILE["mime_type"],
            "size": len(TEXT.encode()),
        }
    ]
    await storage.call(
        "save_progress",
        "session",
        {
            "history": [
                {
                    "type": "function_call",
                    "name": "ask_user",
                    "call_id": "old-ask",
                    "arguments": question().model_dump_json(),
                },
                {
                    "type": "function_call_output",
                    "call_id": "old-ask",
                    "output": json.dumps(
                        {
                            "tool_name": "ask_user",
                            "status": "SUCCESS",
                            "output": answer,
                        }
                    ),
                },
            ]
        },
        WorkingMemory(thread_id="session", objective="build a UI"),
    )
    assert (await storage.call("pending_intents", "session"))[0]["attachments"] == [FILE]
    control.close()
    storage.close()
    endpoint = ModelEndpoint("responses")
    async with endpoint.client() as client:
        configure_client(monkeypatch, client, "responses")
        runtime = create_runtime(directory)
        await runtime.start()
        try:
            for prompt in ("continue", "continue again"):
                task = await runtime.create_task(
                    {
                        "objective": prompt,
                        "workspace_root": str(tmp_path),
                        "session_id": "session",
                        "multi_agent_mode": "off",
                    }
                )
                await finished(runtime, task)
                assert sdk_text(endpoint).count(TEXT) == 1
                assert await runtime.storage.call("pending_intents", "session") == []
        finally:
            await runtime.close()


async def test_pending_attachment_updates_and_acceptance_keep_readable_content(tmp_path):
    storage = LocalStorage(tmp_path / "state")
    update = {
        "id": "update",
        "kind": "supplement",
        "text": "new requirement",
        "attachments": [FILE],
    }
    await storage.call(
        "create", task_record(tmp_path, objective="", attachments=[FILE], intent_updates=[update])
    )
    await storage.call(
        "save_progress",
        "session",
        {
            "history": [
                user_message("", attachments=[FILE]),
            ]
        },
        WorkingMemory(thread_id="session", objective="请查看上传的附件。"),
    )
    storage.close()
    reopened = LocalStorage(tmp_path / "state")
    try:
        assert (await reopened.call("pending_intents", "session"))[0]["attachments"] == [FILE]
        requirement = await reopened.call("acceptance_context", "session")
        assert requirement["user_requests"][0]["attachments"] == [FILE]
        packet, history = acceptance_input({"requirements": requirement})
        assert FILE["data_url"] not in packet and TEXT not in packet
        assert json.loads(packet)["requirements"]["user_requests"][0]["attachments"] == [
            {
                "name": FILE["name"],
                "mime_type": FILE["mime_type"],
                "size": len(TEXT.encode()),
            }
        ]
        content = json.dumps(history, ensure_ascii=False)
        assert content.count(TEXT) == 2 and FILE["data_url"] not in content
        assert FILE["data_url"] not in json.dumps(await reopened.call("diagnostic_snapshot"))
    finally:
        reopened.close()


@pytest.mark.parametrize(
    "confirmation", [{"requires_confirmation": True}, {"operation": {"name": "apply_patch"}}]
)
async def test_attachment_answer_does_not_grant_file_permission(tmp_path, confirmation):
    storage = LocalStorage(tmp_path)
    try:
        await storage.call("create", task_record(tmp_path))
        answer = {
            "text": "Read first",
            "source": "user",
            "permission_granted": False,
            "attachments": [FILE],
        }
        await storage.call(
            "answer_task",
            "task",
            {"status": "RUNNING", "last_answer": answer},
            {"id": "q", "question": "May I edit?", **confirmation},
        )
        pending = await storage.call("pending_intents", "session")
        assert pending[0]["attachments"] == [FILE]
        assert (await storage.call("get_task", "task"))["last_answer"][
            "permission_granted"
        ] is False
    finally:
        storage.close()


async def test_combined_count_limit_is_enforced_at_all_runtime_boundaries(tmp_path):
    fields = {
        "objective": "read",
        "workspace_root": str(tmp_path),
        "images": [IMAGE] * 5,
        "attachments": [FILE],
    }
    with pytest.raises(InteractionError, match="合计最多"):
        _task_input(fields)
    with pytest.raises(InteractionError, match="合计最多"):
        message_input({**fields, "text": "read"}, "补充")
    endpoint = ModelEndpoint("responses")
    async with endpoint.client() as client:
        with pytest.raises(ValueError, match="合计最多"):
            await run_agent(
                "read",
                images=[IMAGE] * 5,
                attachments=[FILE],
                workspace_root=tmp_path,
                response_client=client,
                model_name="vision-fixture",
                model_api="responses",
            )
    assert endpoint.requests == []


@pytest.mark.parametrize("boundary", ["task", "interaction"])
def test_combined_byte_limit_is_enforced_at_submission(tmp_path, monkeypatch, boundary):
    monkeypatch.setattr("bit_agent.attachments.validation.MAX_TOTAL_BYTES", 70)
    fields = {
        "objective": "read",
        "workspace_root": str(tmp_path),
        "images": [IMAGE],
        "attachments": [FILE],
    }
    with pytest.raises((ValueError, InteractionError), match="总大小"):
        if boundary == "task":
            _task_input(fields)
        else:
            message_input({**fields, "text": "read"}, "补充")


async def test_pure_text_omits_attachment_fields_everywhere(tmp_path, monkeypatch):
    endpoint = ModelEndpoint("responses")
    async with endpoint.client() as client:
        configure_client(monkeypatch, client, "responses")
        runtime = create_runtime(tmp_path / "state")
        await runtime.start()
        try:
            task = await runtime.create_task(
                {
                    "objective": "plain text",
                    "workspace_root": str(tmp_path),
                    "multi_agent_mode": "off",
                }
            )
            await finished(runtime, task)
            assert "attachments" not in task
            detail = await runtime.get_session(task["session_id"])
            assert "attachments" not in detail["turns"][0]
            events = await runtime.read_events(task["task_id"], block_ms=0)
            started = next(e for e in events if e["event_type"] == "AGENT_STARTED")
            assert "attachments" not in started["data"]
            result = await runtime.rewind_turn(task["session_id"], task["task_id"])
            assert "attachments" not in result
        finally:
            await runtime.close()
