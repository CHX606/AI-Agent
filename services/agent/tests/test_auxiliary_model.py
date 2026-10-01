"""辅助模型：调查子 Agent、上下文摘要、记忆提炼和提交信息用更便宜的模型。"""

import json
from types import SimpleNamespace

import pytest
from bit_agent.agent.runtime import _summary_model
from bit_agent.observability import InMemoryEventSink
from bit_agent.runtime.application import delegation
from bit_agent.runtime.application.delegation import DelegatingToolProvider, auxiliary_model
from bit_agent.runtime.application.service import AgentRuntime
from bit_agent.runtime.infrastructure.changes import ChangeJournal
from bit_agent.runtime.infrastructure.verification import verify_project
from openai import OpenAI


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("API_KEY", "key")
    monkeypatch.setenv("BASE_URL", "https://example.test/v1")
    monkeypatch.setenv("MODEL_NAME", "big-model")
    monkeypatch.delenv("AUX_MODEL_NAME", raising=False)


def test_auxiliary_model_falls_back_to_main(configured, monkeypatch):
    assert auxiliary_model() == "big-model"
    monkeypatch.setenv("AUX_MODEL_NAME", "small-model")
    assert auxiliary_model() == "small-model"


def test_auxiliary_model_without_configuration(monkeypatch):
    for name in ("API_KEY", "BASE_URL", "MODEL_NAME", "AUX_MODEL_NAME"):
        monkeypatch.delenv(name, raising=False)
    assert auxiliary_model() is None


def test_summaries_use_auxiliary_model_only_for_real_clients(configured, monkeypatch):
    monkeypatch.setenv("AUX_MODEL_NAME", "small-model")
    real = OpenAI(api_key="key", base_url="https://example.test/v1")
    assert _summary_model(real, "big-model") == "small-model"
    assert _summary_model(SimpleNamespace(), "fixture") == "fixture"
    monkeypatch.setenv("AUX_MODEL_NAME", "")
    assert _summary_model(real, "big-model") == "big-model"


async def test_investigations_use_auxiliary_model(configured, monkeypatch, tmp_path):
    monkeypatch.setenv("AUX_MODEL_NAME", "small-model")
    seen = []

    async def fake_run_agent(prompt, **kwargs):
        seen.append(kwargs["model_name"])
        return SimpleNamespace(status="COMPLETED", final_answer="结论", error=None)

    monkeypatch.setattr(delegation, "run_agent", fake_run_agent)
    provider = DelegatingToolProvider(
        tmp_path,
        "on",
        InMemoryEventSink(),
        tmp_path / "artifacts",
        permission_mode="edit",
        journal=ChangeJournal(tmp_path, tmp_path / "artifacts"),
        verifier=verify_project,
    )
    result = await provider.call_tool(
        "delegate_tasks", "call", json.dumps({"tasks": [{"objective": "看看 a.py"}]})
    )
    assert result.output["investigations"][0]["status"] == "COMPLETED"
    assert seen == ["small-model"]


async def test_configure_model_sets_auxiliary(monkeypatch):
    for name in ("API_KEY", "BASE_URL", "MODEL_NAME", "MODEL_API", "AUX_MODEL_NAME"):
        monkeypatch.setenv(name, "placeholder")
    runtime = SimpleNamespace(_model_input=AgentRuntime._model_input)
    payload = {"base_url": "https://x.test/v1", "model": "big", "api_key": "k"}
    result = await AgentRuntime.configure_model(runtime, {**payload, "aux_model": " small "})
    assert result["aux_model"] == "small"
    import os

    assert os.environ["AUX_MODEL_NAME"] == "small"
    result = await AgentRuntime.configure_model(runtime, payload)
    assert result["aux_model"] is None and os.environ["AUX_MODEL_NAME"] == ""
