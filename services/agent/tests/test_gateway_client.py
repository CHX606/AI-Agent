import io
from typing import Any

from bit_agent.client.gateway import GatewayClient


def test_sse_parser_ignores_heartbeats_and_decodes_json() -> None:
    stream = io.BytesIO(
        b": heartbeat\n\n"
        b"id: 1-0\n"
        b"event: TOOL_COMPLETED\n"
        b'data: {"status":"SUCCESS"}\n\n'
    )

    events = list(GatewayClient._parse_sse(stream))

    assert len(events) == 1
    assert events[0].id == "1-0"
    assert events[0].event_type == "TOOL_COMPLETED"
    assert events[0].data == {"status": "SUCCESS"}


def test_sse_parser_supports_multiline_plain_text() -> None:
    stream = io.BytesIO(b"event: note\ndata: first\ndata: second\n\n")

    event = next(GatewayClient._parse_sse(stream))

    assert event.event_type == "note"
    assert event.data == "first\nsecond"


def test_gateway_url_is_normalized() -> None:
    client = GatewayClient("http://127.0.0.1:3000/")
    assert client.base_url == "http://127.0.0.1:3000"


def test_delete_without_body_does_not_claim_json_content_type(monkeypatch) -> None:
    requests: list[Any] = []

    def fake_urlopen(request, *, timeout):
        requests.append(request)
        return io.BytesIO(b'{"task_id":"task-1","status":"CANCELLED"}')

    monkeypatch.setattr("bit_agent.client.gateway.urlopen", fake_urlopen)

    GatewayClient("http://127.0.0.1:3000").cancel_task("task-1")

    assert requests[0].method == "DELETE"
    assert "Content-type" not in requests[0].headers
