"""SDK 接管循环后，产品的交互和文件安全规则仍然必须成立。"""

import asyncio
import json
from types import SimpleNamespace

import pytest
from bit_agent.agent.runtime import run_agent
from bit_agent.observability import InMemoryEventSink
from bit_agent.tools.models import ToolMetadata, ToolResult, ToolStatus


def call(name, identifier):
    return SimpleNamespace(type="function_call", name=name, call_id=identifier, arguments="{}")


class Responses:
    def __init__(self, batches):
        self.batches = iter(batches)
        self.inputs = []

    def create(self, **request):
        self.inputs.append(request["input"])
        batch = next(self.batches)
        return SimpleNamespace(output=batch, output_text="完成" if not batch else "")


class Provider:
    def __init__(self):
        self.calls = []
        self.active = 0
        self.peak = 0
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        self.closed = True

    async def model_tools(self):
        return [
            {
                "type": "function",
                "name": name,
                "description": name,
                "parameters": {"type": "object", "properties": {}},
            }
            for name in ("read_file", "apply_patch", "ask_user", "verify_project")
        ]

    async def call_tool(self, name, identifier, arguments):
        self.active += 1
        self.peak = max(self.peak, self.active)
        self.calls.append(name)
        await asyncio.sleep(0.005)
        self.active -= 1
        return ToolResult(
            tool_name=name,
            tool_call_id=identifier,
            status=ToolStatus.SUCCESS,
            output={"text": "先调查", "source": "user"} if name == "ask_user" else "ok",
            metadata=ToolMetadata(duration_ms=0),
        )


async def run(tmp_path, provider, batches, **options):
    responses = Responses(batches)
    result = await run_agent(
        "调查项目",
        workspace_root=tmp_path,
        response_client=SimpleNamespace(responses=responses),
        model_name="fixture",
        tool_provider=provider,
        event_sink=InMemoryEventSink(),
        **options,
    )
    return result, responses


async def test_question_skips_other_calls_even_if_write_appears_first(tmp_path):
    provider = Provider()
    snapshots = []

    async def save_progress(state, memory):
        snapshots.append(state)

    result, _ = await run(
        tmp_path,
        provider,
        [
            [call("apply_patch", "write"), call("ask_user", "question"), call("read_file", "read")],
            [],
        ],
        save_progress=save_progress,
    )
    assert result.status == "COMPLETED", result.error
    assert provider.calls == ["ask_user"]
    outputs = [
        item for item in snapshots[-1]["history"] if item.get("type") == "function_call_output"
    ]
    assert {item["call_id"] for item in outputs} == {"write", "question", "read"}
    assert sum(json.loads(item["output"]).get("status") == "SKIPPED" for item in outputs) == 2


async def test_steering_invalidates_rest_of_current_batch(tmp_path):
    provider = Provider()
    sent = False

    async def interaction(finishing=False):
        nonlocal sent
        if provider.calls and not sent:
            sent = True
            return [{"id": "new-intent", "kind": "replace", "text": "不要修改，只解释"}]
        return []

    result, responses = await run(
        tmp_path,
        provider,
        [
            [call("read_file", "read"), call("apply_patch", "write")],
            [],
        ],
        interaction=interaction,
    )
    assert result.status == "COMPLETED", result.error
    assert provider.calls == ["read_file"]
    assert result.working_memory.objective == "不要修改，只解释"
    assert "不要修改，只解释" in json.dumps(responses.inputs[-1], ensure_ascii=False)


async def test_sdk_executes_tool_batch_one_at_a_time(tmp_path):
    provider = Provider()
    result, _ = await run(
        tmp_path,
        provider,
        [
            [call("read_file", "a"), call("read_file", "b"), call("read_file", "c")],
            [],
        ],
    )
    assert result.status == "COMPLETED", result.error
    assert provider.peak == 1
    assert len(result.tool_calls) == 3
    assert provider.closed


@pytest.mark.parametrize("options", [{}, {"max_tool_rounds": 25}])
async def test_sdk_can_finish_more_than_twenty_tool_rounds(tmp_path, options):
    provider = Provider()
    result, responses = await run(
        tmp_path, provider,
        [[call("read_file", f"read-{index}")] for index in range(25)] + [[]],
        **options,
    )
    assert result.status == "COMPLETED", result.error
    assert result.rounds == 25
    assert len(provider.calls) == 25
    assert len(responses.inputs) == 26


async def test_configured_round_limit_blocks_the_next_tool_but_preserves_completed_work(tmp_path):
    provider = Provider()
    snapshots = []

    async def save_progress(state, memory):
        snapshots.append(state)

    result, _ = await run(
        tmp_path, provider,
        [[call("read_file", f"read-{index}")] for index in range(3)],
        max_tool_rounds=2, save_progress=save_progress,
    )
    assert result.status == "FAILED"
    assert result.rounds == 2
    assert len(provider.calls) == 2
    outputs = [
        item for item in snapshots[-1]["history"] if item.get("type") == "function_call_output"
    ]
    assert {item["call_id"] for item in outputs} == {"read-0", "read-1"}


async def test_call_plan_is_saved_before_tool_starts(tmp_path):
    saved = []

    async def save_progress(state, memory):
        saved[:] = state["history"]

    class InspectProvider(Provider):
        async def call_tool(self, name, identifier, arguments):
            assert any(item.get("call_id") == identifier for item in saved)
            return await super().call_tool(name, identifier, arguments)

    result, _ = await run(
        tmp_path, InspectProvider(), [[call("read_file", "a")], []], save_progress=save_progress
    )
    assert result.status == "COMPLETED", result.error


async def test_cancel_waits_for_running_tool_cleanup(tmp_path):
    started, cleaned = asyncio.Event(), asyncio.Event()

    class SlowProvider(Provider):
        async def call_tool(self, *_args):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(0.02)
                cleaned.set()

    provider = SlowProvider()
    task = asyncio.create_task(run(tmp_path, provider, [[call("read_file", "slow")]]))
    await asyncio.wait_for(started.wait(), 3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cleaned.is_set()
    assert provider.closed


async def test_interrupted_write_is_not_replayed_after_restart(tmp_path):
    provider = Provider()
    result, responses = await run(
        tmp_path,
        provider,
        [[], []],
        max_tool_rounds=1,
        initial_state={
            "history": [
                {
                    "type": "function_call",
                    "name": "apply_patch",
                    "call_id": "old-write",
                    "arguments": "{}",
                }
            ]
        },
    )
    assert result.status == "FAILED"
    assert "未完成验证" in result.error
    assert provider.calls == []
    assert "无法确认是否已生效" in json.dumps(responses.inputs[0], ensure_ascii=False)
