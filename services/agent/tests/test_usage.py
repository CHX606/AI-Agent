"""模型用量：每次运行自己的用量，以及整个任务（含子 Agent 和辅助请求）的合计。"""

import asyncio
import sys
from types import SimpleNamespace

from bit_agent.agent.runtime import run_agent
from bit_agent.llm.text import create_text
from bit_agent.observability import InMemoryEventSink
from bit_agent.observability.usage import UsageMeter, current_meter
from bit_agent.runtime.bootstrap import create_runtime
from openai import OpenAI

from test_model_api import ChatServer


def test_meter_groups_sub_agents_and_reads_both_usage_shapes():
    meter = UsageMeter()
    meter.add("main", SimpleNamespace(requests=1, input_tokens=100, output_tokens=20))
    meter.add("research-abc", SimpleNamespace(input_tokens=30, output_tokens=5))
    meter.add("research-def", SimpleNamespace(prompt_tokens=10, completion_tokens=1))
    meter.add("auxiliary", None)
    assert meter.snapshot() == {
        "requests": 3,
        "input_tokens": 140,
        "output_tokens": 26,
        "by_agent": {
            "main": {"requests": 1, "input_tokens": 100, "output_tokens": 20},
            "research": {"requests": 2, "input_tokens": 40, "output_tokens": 6},
        },
    }


async def test_run_reports_its_own_usage_and_feeds_the_task_meter(tmp_path):
    meter = UsageMeter()
    token = current_meter.set(meter)
    try:
        with ChatServer([{"content": "完成"}]) as server:
            result = await run_agent(
                "你好",
                workspace_root=tmp_path,
                response_client=OpenAI(api_key="t", base_url=server.url, max_retries=0),
                model_name="m",
                model_api="chat_completions",
                event_sink=InMemoryEventSink(),
            )
    finally:
        current_meter.reset(token)
    # 本地服务每次回复报告 prompt_tokens=1、completion_tokens=1。
    assert result.usage == {"requests": 1, "input_tokens": 1, "output_tokens": 1}
    assert meter.snapshot()["by_agent"] == {
        "main": {"requests": 1, "input_tokens": 1, "output_tokens": 1}
    }


def test_auxiliary_requests_are_counted(monkeypatch):
    monkeypatch.delenv("MODEL_API", raising=False)
    client = SimpleNamespace(
        responses=SimpleNamespace(
            create=lambda **_: SimpleNamespace(
                output_text="摘要", usage=SimpleNamespace(input_tokens=50, output_tokens=7)
            )
        )
    )
    meter = UsageMeter()
    token = current_meter.set(meter)
    try:
        create_text(client, model="m", instructions="i", content="c", timeout=5)
    finally:
        current_meter.reset(token)
    assert meter.snapshot()["by_agent"] == {
        "auxiliary": {"requests": 1, "input_tokens": 50, "output_tokens": 7}
    }


async def test_task_result_contains_task_usage(tmp_path, monkeypatch):
    class Responses:
        def create(self, **request):
            return SimpleNamespace(output=[], output_text="好的")

    monkeypatch.setitem(
        sys.modules,
        "bit_agent.llm.client",
        SimpleNamespace(client=SimpleNamespace(responses=Responses()), model_name="fixture"),
    )
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime = create_runtime(tmp_path / "data")
    await runtime.start()
    try:
        task = await runtime.create_task(
            {"objective": "你好", "workspace_root": str(workspace), "multi_agent_mode": "off"}
        )
        await asyncio.wait_for(runtime._running[task["task_id"]], 10)
        stored = await runtime.get_task(task["task_id"])
        assert stored["status"] == "COMPLETED"
        usage = stored["result"]["task_usage"]
        assert usage["requests"] == 1 and set(usage["by_agent"]) == {"main"}
    finally:
        await runtime.close()
