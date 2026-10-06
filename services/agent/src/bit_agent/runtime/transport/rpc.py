"""JSON-lines transport depends on callables, not the runtime or SQLite implementation."""

import asyncio
import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, TextIO

from bit_agent.images import MAX_INPUT_BYTES
from bit_agent.observability.diagnostics import diagnostic_context, failure, public_error
from bit_agent.runtime.domain.errors import InteractionError


def _oversized_request() -> InteractionError:
    return InteractionError("请求不能超过 28 MiB", 413)


def _read_line(source: TextIO) -> str | None:
    line = source.readline(MAX_INPUT_BYTES + 1)
    if len(line) <= MAX_INPUT_BYTES:
        return line
    # 丢弃同一条过大的 JSONL，避免它的后半段变成另一条请求。
    while line and not line.endswith("\n"):
        line = source.readline(MAX_INPUT_BYTES + 1)
    return None


class JsonLineRpcServer:
    def __init__(self, methods: Mapping[str, Callable[..., Awaitable[Any]]], output: TextIO):
        self.methods = methods
        self.output = output

    async def dispatch(self, line: str) -> None:
        request: dict[str, Any] = {}
        try:
            if len(line.encode("utf-8")) > MAX_INPUT_BYTES:
                raise _oversized_request()
            decoded = json.loads(line)
            if not isinstance(decoded, dict):
                raise ValueError("请求必须是 JSON object")
            request = decoded
            method, params = request.get("method"), request.get("params", {})
            if not isinstance(method, str) or method not in self.methods:
                raise ValueError("不支持的操作")
            if not isinstance(params, dict):
                raise ValueError("请求参数必须是 JSON object")
            with diagnostic_context(
                rpc_id=str(request.get("id")),
                operation=method,
                task_id=params.get("task_id"),
                session_id=params.get("session_id"),
            ):
                result = await self.methods[method](**params)
            response = {"id": request.get("id"), "result": result}
        except Exception as exc:
            response = self._error_response(request, exc)
        self._write_response(response)

    def _error_response(self, request: dict[str, Any], exc: Exception) -> dict[str, Any]:
        status = getattr(exc, "status_code", 400 if isinstance(exc, ValueError) else 500)
        params = request.get("params", {})
        identifier = failure(
            "rpc_failed",
            exc,
            level="warn" if status < 500 else "error",
            rpc_id=str(request.get("id")),
            operation=request.get("method"),
            task_id=params.get("task_id") if isinstance(params, dict) else None,
        )
        error: dict[str, Any] = {
            "message": public_error(identifier, "请求未完成，请检查输入和任务状态"),
            "diagnostic_id": identifier,
            "status_code": status,
        }
        if isinstance(exc, InteractionError):
            error["user_message"] = str(exc)[:2000]
        return {"id": request.get("id"), "error": error}

    def _write_response(self, response: dict[str, Any]) -> None:
        try:
            self.output.write(json.dumps(response, ensure_ascii=False) + "\n")
            self.output.flush()
        except Exception as exc:
            failure("rpc_write_failed", exc, rpc_id=str(response.get("id")))
            raise

    async def serve(self, source: TextIO) -> None:
        pending: set[asyncio.Task[None]] = set()

        def completed(task: asyncio.Task[None]) -> None:
            pending.discard(task)
            if not task.cancelled() and task.exception():
                failure("rpc_dispatch_failed", task.exception())

        try:
            while True:
                line = await asyncio.to_thread(_read_line, source)
                if line == "":
                    break
                if line is None:
                    self._write_response(self._error_response({}, _oversized_request()))
                    continue
                if len(pending) >= 64:
                    await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                task = asyncio.create_task(self.dispatch(line))
                pending.add(task)
                task.add_done_callback(completed)
        finally:
            await asyncio.gather(*pending, return_exceptions=True)
