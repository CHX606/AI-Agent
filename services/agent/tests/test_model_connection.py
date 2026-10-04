"""连接模型服务：超时与重试的默认值，以及连不上时给用户的提示。"""

import httpx2 as httpx
import pytest
from bit_agent.agent.runtime import _model_failure_message, run_agent
from bit_agent.llm import client as llm_client
from bit_agent.observability import InMemoryEventSink
from openai import APIConnectionError, APITimeoutError, AuthenticationError, OpenAI, Timeout

REQUEST = httpx.Request("POST", "https://example.test/v1/responses")


def test_defaults_are_more_patient_than_the_sdk(monkeypatch):
    monkeypatch.delenv("MODEL_CONNECT_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("MODEL_MAX_RETRIES", raising=False)
    assert llm_client.model_timeout().connect == 20.0
    assert llm_client.model_max_retries() == 4
    client = llm_client._client("key", "https://example.test/v1")
    assert client.timeout.connect == 20.0 and client.max_retries == 4


def test_environment_overrides_are_clamped(monkeypatch):
    monkeypatch.setenv("MODEL_CONNECT_TIMEOUT_SECONDS", "45")
    monkeypatch.setenv("MODEL_MAX_RETRIES", "99")
    assert llm_client.model_timeout().connect == 45.0
    assert llm_client.model_max_retries() == 10
    monkeypatch.setenv("MODEL_CONNECT_TIMEOUT_SECONDS", "abc")
    assert llm_client.model_timeout().connect == 20.0


def wrapped(error: BaseException) -> RuntimeError:
    # 模拟 SDK 和诊断层把原始错误包了两层的情况。
    try:
        try:
            raise error
        except BaseException as inner:
            raise RuntimeError("模型请求未完成") from inner
    except RuntimeError as outer:
        return outer


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (APITimeoutError(request=REQUEST), "连接模型服务超时"),
        (APIConnectionError(request=REQUEST), "无法连接模型服务"),
        (
            AuthenticationError(
                "bad key", response=httpx.Response(401, request=REQUEST), body=None
            ),
            "API Key",
        ),
    ],
)
def test_model_failures_get_specific_messages(error, expected):
    assert expected in _model_failure_message(wrapped(error))


def test_other_failures_keep_generic_message():
    assert _model_failure_message(wrapped(ValueError("x"))) is None


async def test_unreachable_model_reports_connection_problem(tmp_path):
    # 本机没有监听的端口：立即连接失败，不等待网络超时。
    client = OpenAI(
        api_key="key",
        base_url="http://127.0.0.1:9/v1",
        timeout=Timeout(5.0, connect=1.0),
        max_retries=0,
    )
    result = await run_agent(
        "你好",
        workspace_root=tmp_path,
        response_client=client,
        model_name="m",
        event_sink=InMemoryEventSink(),
    )
    assert result.status == "FAILED"
    assert "模型服务" in result.error and "继续" in result.error
