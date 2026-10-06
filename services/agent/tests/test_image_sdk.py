"""Assert real OpenAI SDK request payloads for both supported APIs."""

import asyncio
import json
import sys
from types import SimpleNamespace

import httpx2 as httpx
import pytest
from bit_agent.agent.runtime import run_agent
from bit_agent.memory import WorkingMemory
from bit_agent.observability import InMemoryEventSink
from bit_agent.runtime.application import service
from bit_agent.runtime.application.interaction import TaskInteraction
from bit_agent.runtime.bootstrap import create_runtime
from bit_agent.runtime.infrastructure.storage import LocalStorage
from openai import AsyncOpenAI
from test_image_inputs import IMAGE, PNG
from test_runtime_recovery import question, task_record, until


class ModelEndpoint:
    def __init__(self, api, replies=None):
        self.api, self.requests = api, []
        self.replies = iter(replies or [{"text": "Image received"}] * 20)

    def respond(self, request):
        body = json.loads(request.content)
        self.requests.append(body)
        reply = next(self.replies)
        if self.api == "chat_completions":
            payload = {
                "id": "chat-test",
                "object": "chat.completion",
                "created": 0,
                "model": "vision-fixture",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": reply["text"]},
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }
        else:
            output = reply.get("output") or [
                {
                    "type": "message",
                    "id": "message-test",
                    "role": "assistant",
                    "status": "completed",
                    "content": [
                        {"type": "output_text", "text": reply.get("text", ""), "annotations": []}
                    ],
                }
            ]
            payload = {
                "id": "response-test",
                "object": "response",
                "created_at": 0,
                "model": "vision-fixture",
                "status": "completed",
                "output": output,
                "parallel_tool_calls": False,
                "tool_choice": "auto",
                "tools": [],
                "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
            }
        return httpx.Response(200, json=payload)

    def client(self):
        return AsyncOpenAI(
            api_key="fixture",
            base_url="https://model.invalid/v1",
            max_retries=0,
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(self.respond)),
        )

    def messages(self, index=-1):
        return self.requests[index]["input" if self.api == "responses" else "messages"]

    def image_urls(self, index=-1):
        items = [
            part
            for message in self.messages(index)
            if isinstance(message.get("content"), list)
            for part in message["content"]
        ]
        return [
            part["image_url"] if part["type"] == "input_image" else part["image_url"]["url"]
            for part in items
            if part["type"] in {"input_image", "image_url"}
        ]


def configure_client(monkeypatch, client, api):
    monkeypatch.setitem(
        sys.modules,
        "bit_agent.llm.client",
        SimpleNamespace(
            client=client,
            model_name="vision-fixture",
            model_api=lambda: api,
        ),
    )


async def finished(runtime, task):
    await until(lambda: task["task_id"] not in runtime._running)
    current = await runtime.get_task(task["task_id"])
    assert current["status"] == "COMPLETED", current["error"]
    return current


@pytest.mark.parametrize("api", ["responses", "chat_completions"])
@pytest.mark.parametrize("text", ["", "Inspect this screenshot"])
async def test_real_sdk_sends_images_for_image_only_and_text_with_images(tmp_path, api, text):
    endpoint, sink = ModelEndpoint(api), InMemoryEventSink()
    async with endpoint.client() as client:
        result = await run_agent(
            text,
            images=[IMAGE],
            workspace_root=tmp_path,
            response_client=client,
            model_name="vision-fixture",
            model_api=api,
            event_sink=sink,
        )
    assert result.status == "COMPLETED", result.error
    assert endpoint.image_urls() == [IMAGE["data_url"]]
    users = [message for message in endpoint.messages() if message.get("role") == "user"]
    assert len(users[-1]["content"]) == (2 if text else 1)
    assert result.working_memory.objective == (text or "请查看上传的图片。")
    assert PNG not in json.dumps([event.model_dump(mode="json") for event in sink.events])


@pytest.mark.parametrize("kind", ["supplement", "replace"])
async def test_running_user_update_is_sent_as_visual_input(tmp_path, kind):
    endpoint, sent = ModelEndpoint("responses"), False

    async def interaction(finishing=False):
        nonlocal sent
        if sent:
            return []
        sent = True
        return [{"id": "image-update", "kind": kind, "text": "", "images": [IMAGE]}]

    async with endpoint.client() as client:
        result = await run_agent(
            "original task",
            workspace_root=tmp_path,
            response_client=client,
            model_name="vision-fixture",
            model_api="responses",
            event_sink=InMemoryEventSink(),
            interaction=interaction,
        )
    assert result.status == "COMPLETED", result.error
    assert endpoint.image_urls() == [IMAGE["data_url"]]
    assert result.working_memory.objective == (
        "请查看上传的图片。" if kind == "replace" else "original task"
    )
    assert result.working_memory.applied_interaction_ids == ["image-update"]


@pytest.mark.parametrize("api", ["responses", "chat_completions"])
async def test_task_images_survive_restart_and_new_turn_sends_both_images(
    tmp_path, monkeypatch, api
):
    endpoint, directory = ModelEndpoint(api), tmp_path / "state"
    second_image = {**IMAGE, "name": "second.png"}
    async with endpoint.client() as client:
        configure_client(monkeypatch, client, api)
        runtime = create_runtime(directory)
        await runtime.start()
        try:
            first = await runtime.create_task(
                {
                    "objective": "",
                    "images": [IMAGE],
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
            assert detail["turns"][0]["objective"] == ""
            assert detail["turns"][0]["images"] == [IMAGE]
            second = await reopened.create_task(
                {
                    "objective": "",
                    "images": [second_image],
                    "workspace_root": str(tmp_path),
                    "session_id": first["session_id"],
                    "multi_agent_mode": "off",
                }
            )
            await finished(reopened, second)
            assert endpoint.image_urls() == [IMAGE["data_url"], second_image["data_url"]]
        finally:
            await reopened.close()


async def test_queued_image_supplement_reaches_sdk(tmp_path, monkeypatch):
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
                    "images": [IMAGE],
                    "workspace_root": str(tmp_path),
                    "multi_agent_mode": "off",
                }
            )
            assert (await runtime.get_task(second["task_id"]))["status"] == "QUEUED"
            await runtime.interact_task(
                second["task_id"], {"action": "supplement", "text": "", "images": [IMAGE]}
            )
            gate.set()
            await finished(runtime, first)
            await finished(runtime, second)
            assert endpoint.image_urls() == [IMAGE["data_url"]] * 2
            events = await runtime.read_events(second["task_id"], block_ms=0)
            assert PNG not in json.dumps(events)
            intent = next(event for event in events if event["event_type"] == "TASK_INTENT_UPDATED")
            assert intent["data"]["images"][0]["name"] == IMAGE["name"]
            assert "data_url" not in intent["data"]["images"][0]
        finally:
            gate.set()
            await runtime.close()


async def test_unconsumed_image_answer_survives_restart_and_is_applied_once(tmp_path, monkeypatch):
    directory = tmp_path / "state"
    storage = LocalStorage(directory)
    await storage.call("create", task_record(tmp_path))
    control = TaskInteraction(storage, "task")
    asking = asyncio.create_task(control.ask(question()))
    await until(lambda: control.question is not None)
    question_id = control.question["id"]
    await control.request(
        {"action": "answer", "question_id": question_id, "text": "", "images": [IMAGE]}
    )
    answer = await asking
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
                        {"tool_name": "ask_user", "status": "SUCCESS", "output": answer}
                    ),
                },
            ]
        },
        WorkingMemory(thread_id="session", objective="build a UI"),
    )
    assert (await storage.call("pending_intents", "session"))[0]["images"] == [IMAGE]
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
                assert endpoint.image_urls() == [IMAGE["data_url"]]
                assert await runtime.storage.call("pending_intents", "session") == []
        finally:
            await runtime.close()


async def test_image_answer_visual_input_and_metadata_events(tmp_path, monkeypatch):
    ask = {
        "type": "function_call",
        "id": "function-test",
        "call_id": "ask-image",
        "name": "ask_user",
        "arguments": question().model_dump_json(),
        "status": "completed",
    }
    endpoint = ModelEndpoint("responses", [{"output": [ask]}, {"text": "Image received"}])
    async with endpoint.client() as client:
        configure_client(monkeypatch, client, "responses")
        runtime = create_runtime(tmp_path / "state")
        await runtime.start()
        try:
            task = await runtime.create_task(
                {
                    "objective": "Ask me which screenshot",
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
                    "images": [IMAGE],
                },
            )
            await finished(runtime, task)
            assert endpoint.image_urls() == [IMAGE["data_url"]]
            outputs = [
                item["output"]
                for item in endpoint.messages()
                if item.get("type") == "function_call_output"
            ]
            assert outputs and all(PNG not in output for output in outputs)
            detail = await runtime.get_session(task["session_id"])
            assert detail["turns"][0]["intent_updates"][0]["images"] == [IMAGE]
            assert PNG not in json.dumps(await runtime.read_events(task["task_id"], block_ms=0))
            assert await runtime.storage.call("pending_intents", task["session_id"]) == []
        finally:
            await runtime.close()
