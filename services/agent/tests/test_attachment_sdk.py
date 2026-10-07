"""Ordinary attachments become readable inputs through both real SDK adapters."""

import asyncio
import json

import pytest
from bit_agent.agent.runtime import run_agent
from bit_agent.observability import InMemoryEventSink
from bit_agent.runtime.application import service
from bit_agent.runtime.application.acceptance_input import acceptance_input
from bit_agent.runtime.bootstrap import create_runtime
from test_attachment_documents import attachment, document_bytes
from test_image_inputs import IMAGE
from test_image_sdk import ModelEndpoint, configure_client, finished
from test_runtime_recovery import question, until

TEXT = "ATTACH-TEXT-42 中文代码 def answer(): return 42"
FILE = attachment("notes.py", TEXT.encode(), "text/plain")


def sdk_text(endpoint, index=-1):
    return "\n".join(
        item.get("text", "")
        for message in endpoint.messages(index)
        if message.get("role") == "user" and isinstance(message.get("content"), list)
        for item in message["content"]
        if item["type"] in {"input_text", "text"}
    )


@pytest.mark.parametrize("api", ["responses", "chat_completions"])
@pytest.mark.parametrize("text", ["", "Read the supplied file"])
async def test_attachment_only_and_text_reach_real_sdk(tmp_path, api, text):
    endpoint, sink = ModelEndpoint(api), InMemoryEventSink()
    async with endpoint.client() as client:
        result = await run_agent(
            text,
            attachments=[FILE],
            workspace_root=tmp_path,
            response_client=client,
            model_name="vision-fixture",
            model_api=api,
            event_sink=sink,
        )
    assert result.status == "COMPLETED", result.error
    assert TEXT in sdk_text(endpoint) and FILE["name"] in sdk_text(endpoint)
    assert "base64," not in json.dumps(endpoint.requests)
    assert result.working_memory.objective == (text or "请查看上传的附件。")
    started = sink.events[0].model_dump(mode="json")
    assert started["payload"]["attachments"] == [
        {"name": FILE["name"], "mime_type": FILE["mime_type"], "size": len(TEXT.encode())}
    ]
    assert FILE["data_url"] not in json.dumps([e.model_dump(mode="json") for e in sink.events])


@pytest.mark.parametrize("api", ["responses", "chat_completions"])
@pytest.mark.parametrize(
    "kind,marker",
    [
        ("pdf", "ATTACH-PDF-42"),
        ("docx", "ATTACH-WORD-42 中文"),
        ("xlsx", "ATTACH-SHEET-42"),
    ],
)
async def test_real_document_bytes_are_readable_by_both_model_apis(tmp_path, api, kind, marker):
    file = attachment(f"资料.{kind}", document_bytes(kind))
    endpoint = ModelEndpoint(api)
    async with endpoint.client() as client:
        result = await run_agent(
            "",
            attachments=[file],
            workspace_root=tmp_path,
            response_client=client,
            model_name="vision-fixture",
            model_api=api,
            event_sink=InMemoryEventSink(),
        )
    assert result.status == "COMPLETED", result.error
    assert marker in sdk_text(endpoint)
    assert "base64," not in json.dumps(endpoint.requests)


@pytest.mark.parametrize("api", ["responses", "chat_completions"])
async def test_mixed_image_and_document_keep_their_input_types(tmp_path, api):
    endpoint = ModelEndpoint(api)
    async with endpoint.client() as client:
        result = await run_agent(
            "Compare these",
            images=[IMAGE],
            attachments=[FILE],
            workspace_root=tmp_path,
            response_client=client,
            model_name="vision-fixture",
            model_api=api,
            event_sink=InMemoryEventSink(),
        )
    assert result.status == "COMPLETED", result.error
    assert endpoint.image_urls() == [IMAGE["data_url"]]
    assert TEXT in sdk_text(endpoint)
    assert FILE["data_url"] not in json.dumps(endpoint.requests)


@pytest.mark.parametrize("kind", ["supplement", "replace"])
async def test_running_attachment_update_reaches_sdk_and_updates_objective(tmp_path, kind):
    endpoint, sent = ModelEndpoint("responses"), False

    async def interaction(finishing=False):
        nonlocal sent
        if sent:
            return []
        sent = True
        return [{"id": "attachment-update", "kind": kind, "text": "", "attachments": [FILE]}]

    async with endpoint.client() as client:
        result = await run_agent(
            "original task",
            workspace_root=tmp_path,
            response_client=client,
            model_name="vision-fixture",
            model_api="responses",
            interaction=interaction,
            event_sink=InMemoryEventSink(),
        )
    assert result.status == "COMPLETED", result.error
    assert sdk_text(endpoint).count(TEXT) == 1
    assert result.working_memory.objective == (
        "请查看上传的附件。" if kind == "replace" else "original task"
    )
    assert result.working_memory.applied_interaction_ids == ["attachment-update"]


async def test_queued_attachment_supplement_is_persisted_and_sent(tmp_path, monkeypatch):
    endpoint, gate, entered = ModelEndpoint("responses"), asyncio.Event(), asyncio.Event()
    original = service.run_agent

    async def runner(prompt, **options):
        if prompt == "hold":
            entered.set()
            await gate.wait()
        return await original(prompt, **options)

    monkeypatch.setattr(service, "run_agent", runner)
    async with endpoint.client() as client:
        configure_client(monkeypatch, client, "responses")
        runtime = create_runtime(tmp_path / "state")
        await runtime.start()
        try:
            first = await runtime.create_task(
                {"objective": "hold", "workspace_root": str(tmp_path), "multi_agent_mode": "off"}
            )
            await asyncio.wait_for(entered.wait(), 5)
            second = await runtime.create_task(
                {
                    "objective": "",
                    "attachments": [FILE],
                    "workspace_root": str(tmp_path),
                    "multi_agent_mode": "off",
                }
            )
            assert (await runtime.get_task(second["task_id"]))["status"] == "QUEUED"
            await runtime.interact_task(
                second["task_id"],
                {
                    "action": "supplement",
                    "text": "",
                    "attachments": [FILE],
                },
            )
            gate.set()
            await finished(runtime, first)
            await finished(runtime, second)
            assert sdk_text(endpoint).count(TEXT) == 2
            events = await runtime.read_events(second["task_id"], block_ms=0)
            intent = next(e for e in events if e["event_type"] == "TASK_INTENT_UPDATED")
            assert intent["data"]["attachments"][0]["size"] == len(TEXT.encode())
            assert FILE["data_url"] not in json.dumps(events)
        finally:
            gate.set()
            await runtime.close()


async def test_attachment_answer_sdk_content_metadata_and_history(tmp_path, monkeypatch):
    ask = {
        "type": "function_call",
        "id": "function-test",
        "call_id": "ask-file",
        "name": "ask_user",
        "arguments": question().model_dump_json(),
        "status": "completed",
    }
    endpoint = ModelEndpoint("responses", [{"output": [ask]}, {"text": "Read the file"}])
    async with endpoint.client() as client:
        configure_client(monkeypatch, client, "responses")
        runtime = create_runtime(tmp_path / "state")
        await runtime.start()
        try:
            task = await runtime.create_task(
                {
                    "objective": "Ask me for the document",
                    "workspace_root": str(tmp_path),
                    "multi_agent_mode": "off",
                }
            )
            control = runtime._interactions[task["task_id"]]
            await until(lambda: control.question is not None)
            await runtime.interact_task(
                task["task_id"],
                {
                    "action": "answer",
                    "question_id": control.question["id"],
                    "text": "",
                    "attachments": [FILE],
                },
            )
            await finished(runtime, task)
            assert sdk_text(endpoint).count(TEXT) == 1
            outputs = [
                m["output"] for m in endpoint.messages() if m.get("type") == "function_call_output"
            ]
            assert outputs and all(FILE["data_url"] not in o for o in outputs)
            assert any(FILE["name"] in o for o in outputs)
            detail = await runtime.get_session(task["session_id"])
            assert detail["turns"][0]["intent_updates"][0]["attachments"] == [FILE]
            assert await runtime.storage.call("pending_intents", task["session_id"]) == []
            events = await runtime.read_events(task["task_id"], block_ms=0)
            assert FILE["data_url"] not in json.dumps(events)
        finally:
            await runtime.close()


@pytest.mark.parametrize("api", ["responses", "chat_completions"])
async def test_independent_acceptance_receives_attachment_contents_through_sdk(tmp_path, api):
    endpoint = ModelEndpoint(api)
    packet, history = acceptance_input(
        {
            "requirements": {
                "user_requests": [
                    {
                        "objective": "Original request",
                        "attachments": [FILE],
                        "updates": [
                            {
                                "text": "Additional criteria",
                                "kind": "supplement",
                                "attachments": [FILE],
                            }
                        ],
                    }
                ]
            }
        }
    )
    async with endpoint.client() as client:
        result = await run_agent(
            packet,
            initial_state={"history": history},
            workspace_root=tmp_path,
            response_client=client,
            model_name="vision-fixture",
            model_api=api,
            event_sink=InMemoryEventSink(),
        )
    assert result.status == "COMPLETED", result.error
    assert sdk_text(endpoint).count(TEXT) == 2
    assert "base64," not in json.dumps(endpoint.requests)
