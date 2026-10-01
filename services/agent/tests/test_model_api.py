"""Chat Completions 兼容：主循环、单轮文本请求和“测试连接”。"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import httpx2 as httpx
import pytest
from bit_agent.agent.runtime import run_agent
from bit_agent.llm import probe
from bit_agent.llm.text import create_text
from bit_agent.observability import InMemoryEventSink
from bit_agent.runtime.application.service import AgentRuntime
from openai import APIConnectionError, APIStatusError, OpenAI


class ChatServer:
    """只实现 /chat/completions 的本地服务，模拟多数国内服务商和本地推理服务。"""

    def __init__(self, replies):
        self.replies = list(replies)
        self.requests: list[tuple[str, dict]] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                server.requests.append((self.path, body))
                if not self.path.endswith("/chat/completions"):
                    self.send_response(404)
                    self.end_headers()
                    self.wfile.write(b'{"error":{"message":"not found"}}')
                    return
                message = server.replies.pop(0)
                if body.get("stream"):
                    self.stream(body, message)
                    return
                payload = {
                    "id": "chat-1",
                    "object": "chat.completion",
                    "created": 0,
                    "model": body["model"],
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "tool_calls" if message.get("tool_calls") else "stop",
                            "message": {"role": "assistant", "content": None, **message},
                        }
                    ],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                }
                data = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def stream(self, body, message):
                def chunk(delta, finish=None):
                    return {
                        "id": "chat-1",
                        "object": "chat.completion.chunk",
                        "created": 0,
                        "model": body["model"],
                        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                    }

                chunks = [chunk({"role": "assistant"})]
                for index, call in enumerate(message.get("tool_calls", [])):
                    chunks.append(
                        chunk(
                            {"tool_calls": [{"index": index, **call, "function": call["function"]}]}
                        )
                    )
                text = message.get("content") or ""
                chunks += [chunk({"content": part}) for part in (text[:2], text[2:]) if part]
                finish = "tool_calls" if message.get("tool_calls") else "stop"
                chunks.append(chunk({}, finish))
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()
                for item in chunks:
                    self.wfile.write(f"data: {json.dumps(item)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_port}/v1"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.httpd.shutdown()
        self.httpd.server_close()


async def test_agent_loop_runs_on_chat_completions(tmp_path):
    (tmp_path / "hello.txt").write_text("hi")
    replies = [
        {
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "list_files", "arguments": '{"path": "", "max_depth": 0}'},
                }
            ]
        },
        {"content": "目录里有 hello.txt"},
    ]
    with ChatServer(replies) as server:
        result = await run_agent(
            "看看目录里有什么",
            workspace_root=tmp_path,
            response_client=OpenAI(api_key="test", base_url=server.url, max_retries=0),
            model_name="local-model",
            model_api="chat_completions",
            event_sink=InMemoryEventSink(),
        )
    assert result.status == "COMPLETED", result.error
    assert result.final_answer == "目录里有 hello.txt"
    assert [call.tool_name for call in result.tool_calls] == ["list_files"]
    paths = {path for path, _ in server.requests}
    assert paths == {"/v1/chat/completions"}
    first = server.requests[0][1]
    # 兼容服务常常不认识这两个参数，Chat Completions 模式下不发送。
    assert "store" not in first and "parallel_tool_calls" not in first
    assert first["tools"][0]["type"] == "function"


async def test_streamed_chat_completions_emit_text_and_tools(tmp_path, monkeypatch):
    monkeypatch.setenv("BIT_AGENT_STREAMING", "1")
    (tmp_path / "hello.txt").write_text("hi")
    replies = [
        {
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "list_files", "arguments": '{"path": "", "max_depth": 0}'},
                }
            ]
        },
        {"content": "目录里有 hello.txt"},
    ]
    sink = InMemoryEventSink()
    with ChatServer(replies) as server:
        result = await run_agent(
            "看看目录",
            workspace_root=tmp_path,
            response_client=OpenAI(api_key="test", base_url=server.url, max_retries=0),
            model_name="local-model",
            model_api="chat_completions",
            event_sink=sink,
        )
    assert result.status == "COMPLETED", result.error
    assert [call.tool_name for call in result.tool_calls] == ["list_files"]
    deltas = [
        event.payload["text"] for event in sink.events if event.event_type == "MODEL_TEXT_DELTA"
    ]
    assert "".join(deltas) == "目录里有 hello.txt"
    assert all(body.get("stream") for _, body in server.requests)


async def test_configured_model_api_is_used_for_real_clients(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_API", "chat_completions")
    with ChatServer([{"content": "你好"}]) as server:
        result = await run_agent(
            "你好",
            workspace_root=tmp_path,
            response_client=OpenAI(api_key="test", base_url=server.url, max_retries=0),
            model_name="local-model",
            event_sink=InMemoryEventSink(),
        )
    assert result.status == "COMPLETED", result.error
    assert server.requests[0][0] == "/v1/chat/completions"


async def test_invalid_model_api_is_rejected(tmp_path):
    with pytest.raises(ValueError, match="model_api"):
        await run_agent(
            "x",
            workspace_root=tmp_path,
            response_client=SimpleNamespace(),
            model_name="m",
            model_api="completions",
        )


def test_create_text_uses_chat_completions_when_configured(monkeypatch):
    calls = []

    class Completions:
        def create(self, **request):
            calls.append(request)
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok": true}'))]
            )

    client = SimpleNamespace(chat=SimpleNamespace(completions=Completions()))
    monkeypatch.setenv("MODEL_API", "chat_completions")
    text = create_text(client, model="m", instructions="规则", content="内容", timeout=5)
    assert text == '{"ok": true}'
    assert calls[0]["messages"] == [
        {"role": "system", "content": "规则"},
        {"role": "user", "content": "内容"},
    ]


def test_create_text_keeps_responses_by_default(monkeypatch):
    monkeypatch.delenv("MODEL_API", raising=False)

    class Responses:
        def create(self, **request):
            assert request["input"][0]["role"] == "developer"
            return SimpleNamespace(output_text="done")

    client = SimpleNamespace(responses=Responses(), chat=object())
    assert create_text(client, model="m", instructions="i", content="c", timeout=5) == "done"


def status_error(code: int) -> APIStatusError:
    request = httpx.Request("POST", "https://example.test/v1")
    return APIStatusError("error", response=httpx.Response(code, request=request), body=None)


async def test_probe_falls_back_to_chat_completions(monkeypatch):
    def ping(client, model, api):
        if api == "responses":
            raise status_error(404)

    monkeypatch.setattr(probe, "_ping", ping)
    result = await probe.probe_model("https://example.test/v1", "m", "key")
    assert result["ok"] and result["api"] == "chat_completions"
    assert result["attempts"] == [
        {"api": "responses", "status_code": 404, "message": probe._STATUS_HINTS[404]}
    ]


async def test_probe_stops_on_rejected_key(monkeypatch):
    tried = []

    def ping(client, model, api):
        tried.append(api)
        raise status_error(401)

    monkeypatch.setattr(probe, "_ping", ping)
    result = await probe.probe_model("https://example.test/v1", "m", "key")
    assert not result["ok"] and result["message"] == "API Key 被拒绝"
    assert tried == ["responses"], "密钥错误时换接口也没有用"


async def test_probe_treats_unrecognised_reply_as_unsupported(monkeypatch):
    def ping(client, model, api):
        if api == "responses":
            raise ValueError("not a response object")

    monkeypatch.setattr(probe, "_ping", ping)
    result = await probe.probe_model("https://example.test/v1", "m", "key")
    assert result["ok"] and result["api"] == "chat_completions"
    assert "无法识别" in result["attempts"][0]["message"]


async def test_probe_reports_unreachable_address(monkeypatch):
    def ping(client, model, api):
        raise APIConnectionError(request=httpx.Request("POST", "https://example.test/v1"))

    monkeypatch.setattr(probe, "_ping", ping)
    result = await probe.probe_model("https://example.test/v1", "m", "key", "responses")
    assert not result["ok"] and "无法连接" in result["message"]


async def test_probe_against_local_chat_server():
    with ChatServer([{"content": "pong"}]) as server:
        result = await probe.probe_model(server.url.replace("/v1", "") + "/v1", "m", "key")
    assert result["ok"] and result["api"] == "chat_completions", result
    responses_attempt = server.requests[0]
    assert responses_attempt[0] == "/v1/responses"
    chat_request = server.requests[1][1]
    assert chat_request["tools"][0]["function"]["name"] == "noop"


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"base_url": "http://example.com/v1", "model": "m", "api_key": "k"}, "HTTPS"),
        ({"base_url": "https://x/v1", "model": "m", "api_key": "k", "api": "x"}, "接口类型"),
        ({"base_url": "https://x/v1", "model": "", "api_key": "k"}, "不能为空"),
    ],
)
async def test_model_input_is_validated(payload, message):
    with pytest.raises(ValueError, match=message):
        await AgentRuntime.test_model(
            SimpleNamespace(_model_input=AgentRuntime._model_input), payload
        )


async def test_configure_model_sets_api(monkeypatch):
    # configure_model 直接写 os.environ；先经 monkeypatch 登记，测试结束后才会还原。
    for name in ("API_KEY", "BASE_URL", "MODEL_NAME", "MODEL_API", "AUX_MODEL_NAME"):
        monkeypatch.setenv(name, "placeholder")
    runtime = SimpleNamespace(_model_input=AgentRuntime._model_input)
    result = await AgentRuntime.configure_model(
        runtime,
        {
            "base_url": "http://127.0.0.1:11434/v1",
            "model": "qwen",
            "api_key": "ollama",
            "api": "chat_completions",
        },
    )
    assert result["api"] == "chat_completions"
    import os

    assert os.environ["MODEL_API"] == "chat_completions"
    with pytest.raises(ValueError, match="接口类型"):
        await AgentRuntime.configure_model(
            runtime, {"base_url": "https://x/v1", "model": "m", "api_key": "k", "api": "auto"}
        )
