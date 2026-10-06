"""Images survive context handling and restart without becoming a base64 text prompt."""

import json
from types import SimpleNamespace

import pytest
from bit_agent.context import ContextManager
from bit_agent.context.models import ContextSummary
from bit_agent.context.serialization import estimate_context_tokens, serialize_items, to_json_value
from bit_agent.context.summarizer import LLMContextSummarizer
from bit_agent.images import user_message
from bit_agent.memory import WorkingMemory
from bit_agent.runtime.infrastructure.storage import LocalStorage

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII="
IMAGE = {
    "name": "capture.png",
    "mime_type": "image/png",
    "data_url": f"data:image/png;base64,{PNG}",
}


def task():
    return {
        "task_id": "task",
        "session_id": "session",
        "objective": "",
        "status": "RUNNING",
        "workspace_root": "D:/workspace",
        "multi_agent_mode": "smart",
        "created_at": "2026-10-05T00:00:00Z",
        "images": [IMAGE],
        "intent_updates": [
            {
                "id": "update",
                "kind": "supplement",
                "text": "another screenshot",
                "accepted_at": "2026-10-05T00:00:01Z",
                "images": [IMAGE],
            }
        ],
    }


async def test_large_image_does_not_overflow_the_text_context_budget():
    image = {**IMAGE, "data_url": "data:image/png;base64," + "A" * 3_000_000}
    history = [user_message("Find this button", [image])]
    estimate = estimate_context_tokens(history, [])
    assert 0 < estimate < 20_000
    original = to_json_value(history)
    prepared = await ContextManager().prepare(
        history,
        working_memory=WorkingMemory(thread_id="session", objective="Find this button"),
        tools=[],
    )
    assert to_json_value(prepared.items) == original
    assert "A" * 1_000 not in serialize_items(history)


@pytest.mark.parametrize("api", ["responses", "chat_completions"])
async def test_summary_analyzes_images_as_visual_input_not_json_text(api, monkeypatch):
    requests = []

    def create(**request):
        requests.append(request)
        text = ContextSummary(
            objective="task", confirmed_facts=["Visible button is orange"]
        ).model_dump_json()
        return SimpleNamespace(
            output_text=text, choices=[SimpleNamespace(message=SimpleNamespace(content=text))]
        )

    client = SimpleNamespace(
        responses=SimpleNamespace(create=create),
        chat=SimpleNamespace(completions=SimpleNamespace(create=create)),
    )
    monkeypatch.setenv("MODEL_API", api)
    summary = await LLMContextSummarizer(client, "vision-model").summarize(
        [user_message("Inspect the screenshot", [IMAGE])],
        previous_summary=None,
        working_memory=WorkingMemory(thread_id="session", objective="task"),
    )
    assert "Visible button is orange" in summary.confirmed_facts
    content = requests[0]["input" if api == "responses" else "messages"][-1]["content"]
    assert content[0]["type"] in {"input_text", "text"}
    assert PNG not in content[0]["text"]
    visual = content[1]
    assert visual["type"] == ("input_image" if api == "responses" else "image_url")
    assert (visual["image_url"] if api == "responses" else visual["image_url"]["url"]) == IMAGE[
        "data_url"
    ]


async def test_images_and_pending_inputs_survive_database_restart(tmp_path):
    storage = LocalStorage(tmp_path)
    await storage.call("create", task())
    memory = WorkingMemory(thread_id="session", objective="Please inspect images")
    await storage.call("save_progress", "session", {"history": [user_message("", [IMAGE])]}, memory)
    storage.close()
    reopened = LocalStorage(tmp_path)
    try:
        history = await reopened.call("get_session", "session")
        assert history["session"]["title"]
        assert history["turns"][0]["objective"] == ""
        assert history["turns"][0]["images"] == [IMAGE]
        assert history["turns"][0]["intent_updates"][0]["images"] == [IMAGE]
        assert (await reopened.call("pending_intents", "session"))[0]["images"] == [IMAGE]
        assert (await reopened.call("acceptance_context", "session"))["user_requests"][0][
            "images"
        ] == [IMAGE]
        assert PNG not in json.dumps(await reopened.call("diagnostic_snapshot"))
    finally:
        reopened.close()


async def test_image_answer_is_not_acknowledged_before_visual_input_is_saved(tmp_path):
    storage = LocalStorage(tmp_path)
    try:
        await storage.call("create", task())
        question = {"id": "q", "question": "Which screenshot?"}
        answer = {"text": "This one", "source": "user", "images": [IMAGE]}
        await storage.call(
            "answer_task", "task", {"status": "RUNNING", "last_answer": answer}, question
        )
        memory = WorkingMemory(thread_id="session", objective="task")
        tool_output = {
            "type": "function_call_output",
            "call_id": "q",
            "output": json.dumps(
                {
                    "tool_name": "ask_user",
                    "status": "SUCCESS",
                    "output": {"question_id": "q", "source": "user"},
                }
            ),
        }
        await storage.call("save_progress", "session", {"history": [tool_output]}, memory)
        pending = await storage.call("pending_intents", "session")
        assert any(item["id"] == "answer_q" and item["images"] == [IMAGE] for item in pending)
        memory.applied_interaction_ids.append("answer_q")
        await storage.call(
            "save_progress",
            "session",
            {"history": [tool_output, user_message("This one", [IMAGE])]},
            memory,
        )
        assert all(
            item["id"] != "answer_q" for item in await storage.call("pending_intents", "session")
        )
    finally:
        storage.close()


@pytest.mark.parametrize(
    "confirmation", [{"requires_confirmation": True}, {"operation": {"name": "apply_patch"}}]
)
async def test_image_confirmation_answer_survives_restart_without_granting_permission(
    tmp_path, confirmation
):
    storage = LocalStorage(tmp_path)
    await storage.call("create", task())
    question = {"id": "q", "question": "May I modify the file?", **confirmation}
    answer = {
        "text": "Inspect this first",
        "source": "user",
        "permission_granted": False,
        "images": [IMAGE],
    }
    await storage.call(
        "answer_task", "task", {"status": "RUNNING", "last_answer": answer}, question
    )
    storage.close()
    reopened = LocalStorage(tmp_path)
    try:
        pending = await reopened.call("pending_intents", "session")
        assert any(item["id"] == "answer_q" and item["images"] == [IMAGE] for item in pending)
        history = await reopened.call("get_session", "session")
        assert any(item["id"] == "answer_q" for item in history["turns"][0]["intent_updates"])
        recovered = await reopened.call("get_task", "task")
        assert recovered["last_answer"]["permission_granted"] is False
    finally:
        reopened.close()
