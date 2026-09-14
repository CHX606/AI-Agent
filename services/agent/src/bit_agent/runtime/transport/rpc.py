"""JSON-lines transport depends on callables, not the runtime or SQLite implementation."""

import asyncio
import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, TextIO

from bit_agent.observability.diagnostics import diagnostic_context, failure, public_error


class JsonLineRpcServer:
    def __init__(self, methods: Mapping[str, Callable[..., Awaitable[Any]]], output: TextIO):
        self.methods = methods
        self.output = output

    async def dispatch(self, line: str) -> None:
        request: dict[str, Any] = {}
        try:
            decoded = json.loads(line)
            if not isinstance(decoded, dict):
                raise ValueError("请求必须是 JSON object")
            request = decoded
            method = request.get("method")
            if method not in self.methods:
                raise ValueError("不支持的操作")
            params = request.get("params", {})
            with diagnostic_context(
                rpc_id=str(request.get("id")),
                operation=method,
                task_id=params.get("task_id"),
                session_id=params.get("session_id"),
            ):
                result = await self.methods[method](**params)
            response = {"id": request.get("id"), "result": result}
        except Exception as exc:
            status = getattr(exc, "status_code", 400 if isinstance(exc, ValueError) else 500)
            identifier = failure(
                "rpc_failed",
                exc,
                level="warn" if status < 500 else "error",
                rpc_id=str(request.get("id")),
                operation=request.get("method"),
                task_id=request.get("params", {}).get("task_id")
                if isinstance(request.get("params", {}), dict) else None,
            )
            response = {
                "id": request.get("id"),
                "error": {
                    "message": public_error(identifier, "请求未完成，请检查输入和任务状态"),
                    "diagnostic_id": identifier,
                    "status_code": status,
                },
            }
        try:
            self.output.write(json.dumps(response, ensure_ascii=False) + "\n")
            self.output.flush()
        except Exception as exc:
            failure("rpc_write_failed", exc, rpc_id=str(request.get("id")))
            raise

    async def serve(self, source: TextIO) -> None:
        pending: set[asyncio.Task[None]] = set()

        def completed(task: asyncio.Task[None]) -> None:
            pending.discard(task)
            if not task.cancelled() and task.exception():
                failure("rpc_dispatch_failed", task.exception())

        try:
            while line := await asyncio.to_thread(source.readline):
                if len(pending) >= 64:
                    await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                task = asyncio.create_task(self.dispatch(line))
                pending.add(task)
                task.add_done_callback(completed)
        finally:
            await asyncio.gather(*pending, return_exceptions=True)
