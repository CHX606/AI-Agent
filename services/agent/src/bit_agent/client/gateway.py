"""使用标准库访问 Bit Agent Gateway。"""

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


class GatewayClientError(RuntimeError):
    """Gateway 请求失败。"""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True, slots=True)
class GatewayEvent:
    """Gateway SSE 返回的一条事件。"""

    id: str | None
    event_type: str
    data: Any


class GatewayClient:
    """CLI 使用的同步 Gateway 客户端。"""

    def __init__(self, base_url: str, *, timeout_seconds: float = 30.0) -> None:
        normalized = base_url.strip().rstrip("/")
        if not normalized.startswith(("http://", "https://")):
            raise ValueError("Gateway URL 必须以 http:// 或 https:// 开头")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds 必须大于 0")
        self.base_url = normalized
        self.timeout_seconds = timeout_seconds

    def create_task(self, objective: str, workspace_root: str) -> dict[str, Any]:
        return self._request_json(
            "POST",
            "/v1/tasks",
            {"objective": objective, "workspace_root": workspace_root},
        )

    def get_task(self, task_id: str) -> dict[str, Any]:
        return self._request_json("GET", f"/v1/tasks/{quote(task_id, safe='')}")

    def get_result(self, task_id: str) -> dict[str, Any]:
        return self._request_json("GET", f"/v1/tasks/{quote(task_id, safe='')}/result")

    def cancel_task(self, task_id: str) -> dict[str, Any]:
        return self._request_json("DELETE", f"/v1/tasks/{quote(task_id, safe='')}")

    def iter_events(self, task_id: str, *, after: str | None = None) -> Iterator[GatewayEvent]:
        path = f"/v1/tasks/{quote(task_id, safe='')}/events"
        if after:
            path += f"?after={quote(after, safe='')}"
        request = Request(
            self.base_url + path,
            headers={"accept": "text/event-stream"},
            method="GET",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                yield from self._parse_sse(response)
        except HTTPError as exc:
            raise self._http_error(exc) from exc
        except URLError as exc:
            raise GatewayClientError(f"无法连接 Gateway：{exc.reason}") from exc

    def _request_json(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"accept": "application/json"}
        if body is not None:
            headers["content-type"] = "application/json"
        request = Request(
            self.base_url + path,
            data=body,
            headers=headers,
            method=method,
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                decoded = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            raise self._http_error(exc) from exc
        except URLError as exc:
            raise GatewayClientError(f"无法连接 Gateway：{exc.reason}") from exc
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise GatewayClientError("Gateway 返回了无效 JSON") from exc
        if not isinstance(decoded, dict):
            raise GatewayClientError("Gateway 返回值必须是 JSON object")
        return decoded

    @staticmethod
    def _http_error(error: HTTPError) -> GatewayClientError:
        try:
            payload = json.loads(error.read().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = None
        if isinstance(payload, dict):
            detail = str(payload.get("message") or payload.get("error") or payload)
        else:
            detail = error.reason
        return GatewayClientError(
            f"Gateway 请求失败（HTTP {error.code}）：{detail}",
            status_code=error.code,
        )

    @staticmethod
    def _parse_sse(lines: Any) -> Iterator[GatewayEvent]:
        event_id: str | None = None
        event_type = "message"
        data_lines: list[str] = []

        for raw_line in lines:
            line = raw_line.decode("utf-8").rstrip("\r\n")
            if not line:
                if data_lines:
                    raw_data = "\n".join(data_lines)
                    try:
                        data = json.loads(raw_data)
                    except json.JSONDecodeError:
                        data = raw_data
                    yield GatewayEvent(event_id, event_type, data)
                event_id = None
                event_type = "message"
                data_lines = []
                continue
            if line.startswith(":"):
                continue
            field, separator, value = line.partition(":")
            if separator and value.startswith(" "):
                value = value[1:]
            if field == "id":
                event_id = value
            elif field == "event":
                event_type = value
            elif field == "data":
                data_lines.append(value)
