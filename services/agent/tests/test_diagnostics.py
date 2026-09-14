import asyncio
import io
import json
import os
from types import SimpleNamespace

import httpx2 as httpx
import pytest
from bit_agent.observability.diagnostics import (
    configure_logging,
    diagnostic_context,
    failure,
    record,
    register_secret,
)
from bit_agent.observability.model import DiagnosedModelError, DiagnosticHttpClient, DiagnosticModel
from bit_agent.runtime.bootstrap import create_runtime
from bit_agent.runtime.infrastructure.changes import write_json
from bit_agent.runtime.infrastructure.storage import LocalStorage
from bit_agent.runtime.transport.rpc import JsonLineRpcServer
from openai import AsyncOpenAI, RateLimitError


def logs(path):
    return [
        json.loads(line)
        for file in (path / "python").glob("current.jsonl*")
        for line in file.read_text(encoding="utf-8").splitlines()
    ]


async def test_model_http_error_retries_and_redaction(tmp_path):
    configure_logging(tmp_path)
    register_secret("secret-key-123")
    attempts = []

    def respond(request):
        attempts.append(request.headers.get("x-stainless-retry-count"))
        return httpx.Response(
            429,
            headers={"x-request-id": "provider-123", "retry-after-ms": "1"},
            json={
                "error": {
                    "code": "rate_limit_exceeded",
                    "message": "secret-key-123 FULL PRIVATE PROMPT",
                }
            },
        )

    async with AsyncOpenAI(
        api_key="secret-key-123",
        base_url="https://example.invalid/v1",
        max_retries=1,
        http_client=DiagnosticHttpClient(transport=httpx.MockTransport(respond)),
    ) as client:
        with diagnostic_context(task_id="task-1", session_id="session-1"):
            with pytest.raises(RateLimitError):
                await client.responses.create(model="fixture", input="FULL PRIVATE PROMPT")
    records = logs(tmp_path)
    responses = [r for r in records if r["event"] == "model_http_response"]
    assert attempts == ["0", "1"]
    assert [r["retry_count"] for r in responses] == [0, 1]
    assert all(
        r["status_code"] == 429
        and r["provider_request_id"] == "provider-123"
        and r["session_id"] == "session-1"
        for r in responses
    )
    assert "FULL PRIVATE PROMPT" not in json.dumps(records)
    assert "secret-key-123" not in json.dumps(records)


@pytest.mark.parametrize("abrupt", [True, False])
async def test_stream_failure_including_silent_eof(tmp_path, abrupt):
    configure_logging(tmp_path)

    class StreamModel:
        async def stream_response(self, *args, **kwargs):
            yield SimpleNamespace(type="response.created")
            if abrupt:
                raise httpx.ReadError("PRIVATE RESPONSE CONTENT")

    with pytest.raises(DiagnosedModelError) as raised:
        async for _ in DiagnosticModel(StreamModel()).stream_response():
            pass
    rows = logs(tmp_path)
    assert rows[-1]["event"] == "model_stream_failed"
    assert raised.value.diagnostic_id == rows[-1]["diagnostic_id"]
    assert "PRIVATE RESPONSE" not in json.dumps(rows)


async def test_timeout_and_cancel_are_distinct(tmp_path):
    configure_logging(tmp_path)

    async def timeout(request):
        raise httpx.ReadTimeout("PRIVATE URL")

    async with DiagnosticHttpClient(transport=httpx.MockTransport(timeout)) as client:
        with pytest.raises(httpx.ReadTimeout):
            await client.get("https://example.invalid")

    class CancelModel:
        async def get_response(self, *args, **kwargs):
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await DiagnosticModel(CancelModel()).get_response()
    rows = logs(tmp_path)
    assert any(r.get("reason") == "timeout" for r in rows)
    assert rows[-1]["level"] == "INFO" and rows[-1]["event"] == "model_cancelled"


async def test_storage_failure_rpc_and_log_failure_do_not_hide_original(tmp_path):
    configure_logging(tmp_path / "logs")
    storage = LocalStorage(tmp_path / "data")
    storage._db.execute("PRAGMA query_only=ON")
    with pytest.raises(Exception) as original:
        await storage.call("event", "task-1", "TEST", {"text": "PRIVATE CONTENT"})
    assert "readonly" in str(original.value)
    assert getattr(original.value, "diagnostic_id", None)
    output = io.StringIO()

    async def broken():
        raise original.value

    await JsonLineRpcServer({"save": broken}, output).dispatch('{"id":1,"method":"save"}')
    response = json.loads(output.getvalue())
    assert response["error"]["diagnostic_id"] == original.value.diagnostic_id
    assert "readonly" not in response["error"]["message"]
    invalid = tmp_path / "file"
    invalid.write_text("x")
    assert configure_logging(invalid) is None
    assert failure("test", original.value) == original.value.diagnostic_id
    storage.close()


async def test_existing_events_supply_phase_without_exporting_contents(tmp_path):
    runtime = create_runtime(tmp_path / "data")
    task = {
        "task_id": "task-1",
        "session_id": "session-1",
        "status": "RUNNING",
        "created_at": "2026-09-11T00:00:00+00:00",
        "updated_at": "2026-09-11T00:00:00+00:00",
        "objective": "PRIVATE OBJECTIVE",
        "workspace_root": str(tmp_path),
        "multi_agent_mode": "off",
    }
    await runtime.storage.call("create", task)
    await runtime.storage.call(
        "event",
        "task-1",
        "MODEL_REQUESTED",
        {"agent_id": "main", "payload": {"prompt": "PRIVATE PROMPT"}},
    )
    snapshot = await runtime.diagnostic_snapshot("task-1")
    assert snapshot["tasks"][0]["phase"] == "model"
    assert "PRIVATE" not in json.dumps(snapshot)
    await runtime.storage.call("event", "task-1", "MODEL_RESPONDED", {"agent_id": "main"})
    await runtime.storage.call(
        "event",
        "task-1",
        "TOOL_REQUESTED",
        {"payload": {"tool_call_id": "call-1", "arguments": "PRIVATE"}},
    )
    assert (await runtime.diagnostic_snapshot())["tasks"][0]["phase"] == "tool"
    await runtime.close()


def test_rotation_and_retention(tmp_path):
    configure_logging(tmp_path, max_bytes=700, backups=2)
    for count in range(30):
        record("info", "user_cancelled", count=count)
    files = list((tmp_path / "python").glob("current.jsonl*"))
    assert 1 < len(files) <= 3
    assert sum(f.stat().st_size for f in files) < 2200
    assert all(r["level"] == "INFO" for r in logs(tmp_path))


def test_expired_python_logs_and_file_save_failure(tmp_path, monkeypatch):
    configure_logging(tmp_path / "logs")
    old = tmp_path / "logs" / "python" / "current.jsonl.3"
    old.write_text("expired")
    os.utime(old, (1, 1))
    record("info", "retention_check")
    assert not old.exists()
    original = OSError(28, "PRIVATE CONTENT disk full")

    def fail_replace(*args):
        raise original

    monkeypatch.setattr(os, "replace", fail_replace)
    with pytest.raises(OSError) as caught:
        write_json(tmp_path / "state.json", {"private": "USER FILE"})
    assert caught.value is original
    entries = logs(tmp_path / "logs")
    assert entries[-1]["event"] == "file_save_failed"
    assert entries[-1]["error_code"] == "ENOSPC"
    assert "PRIVATE CONTENT" not in json.dumps(entries)
    assert not list(tmp_path.glob("state.json.*.tmp"))
