"""输入框里临时选的模型和思考程度：按任务保存、传给 SDK，不支持时给出能照做的提示。"""

import asyncio
from types import SimpleNamespace

import pytest
from bit_agent.agent import runtime as runtime_module
from bit_agent.agent.result import AgentRunResult, AgentRunStatus
from bit_agent.agent.runtime import _model_failure_message, run_agent
from bit_agent.observability import InMemoryEventSink
from bit_agent.runtime.application import service
from bit_agent.runtime.bootstrap import create_runtime
from openai import BadRequestError, NotFoundError


class Model:
    def __init__(self):
        self.responses = self

    def create(self, **request):
        return SimpleNamespace(output=[], output_text="好的")


@pytest.mark.parametrize("api", ["responses", "chat_completions"])
@pytest.mark.parametrize("effort", [None, "high"])
async def test_thinking_level_reaches_the_sdk_model_settings(tmp_path, monkeypatch, api, effort):
    captured = {}
    real_agent = runtime_module.Agent

    def recording_agent(*args, **kwargs):
        captured["settings"] = kwargs["model_settings"]
        return real_agent(*args, **kwargs)

    monkeypatch.setattr(runtime_module, "Agent", recording_agent)
    result = await run_agent(
        "你好",
        workspace_root=tmp_path,
        response_client=Model(),
        model_name="gpt-5.5-mini",
        model_api=api,
        reasoning_effort=effort,
        event_sink=InMemoryEventSink(),
    )
    # 测试替身只实现 Responses 形状；Chat Completions 这里只检查组装好的设置。
    if api == "responses":
        assert result.status == "COMPLETED", result.error
    reasoning = captured["settings"].reasoning
    assert (reasoning.effort if reasoning else None) == effort


async def test_unknown_thinking_level_is_rejected(tmp_path):
    with pytest.raises(ValueError, match="思考程度"):
        await run_agent(
            "你好",
            workspace_root=tmp_path,
            response_client=Model(),
            model_name="m",
            reasoning_effort="extreme",
            event_sink=InMemoryEventSink(),
        )


async def test_task_keeps_its_model_and_thinking_level(tmp_path, monkeypatch):
    seen = {}
    done = asyncio.Event()

    async def runner(prompt, **kwargs):
        seen.update(model=kwargs.get("model_name"), effort=kwargs.get("reasoning_effort"))
        done.set()
        return AgentRunResult(status=AgentRunStatus.COMPLETED, final_answer=prompt, rounds=0)

    monkeypatch.setattr(service, "run_agent", runner)
    project = tmp_path / "project"
    project.mkdir()
    runtime = create_runtime(tmp_path / "data")
    await runtime.start()
    try:
        task = await runtime.create_task(
            {
                "objective": "修一下",
                "workspace_root": str(project),
                "model": "gpt-5.5-mini",
                "reasoning_effort": "xhigh",
            }
        )
        assert task["model"] == "gpt-5.5-mini" and task["reasoning_effort"] == "xhigh"
        await asyncio.wait_for(done.wait(), 5)
        assert seen == {"model": "gpt-5.5-mini", "effort": "xhigh"}
        for bad in ({"model": "bad model; rm -rf"}, {"reasoning_effort": "ultra"}):
            with pytest.raises(ValueError):
                await runtime.create_task({"objective": "x", "workspace_root": str(project), **bad})
    finally:
        await runtime.close()


def test_unsupported_model_or_level_gets_an_actionable_message():
    response = SimpleNamespace(status_code=400, headers={}, request=None)
    level = BadRequestError(
        "Unsupported value: 'reasoning.effort' does not support 'xhigh' with this model.",
        response=response,
        body=None,
    )
    assert "思考程度" in _model_failure_message(level)
    missing = NotFoundError("The model `gpt-9` does not exist", response=response, body=None)
    assert "换一个模型" in _model_failure_message(missing)
