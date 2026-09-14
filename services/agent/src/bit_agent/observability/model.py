"""SDK/HTTP adapters: preserve SDK retry/timeout behavior and never log bodies or headers."""

import asyncio
import time
from typing import Any

import httpx2 as httpx
from agents.models.interface import Model
from openai import DEFAULT_CONNECTION_LIMITS, DEFAULT_TIMEOUT

from bit_agent.observability.diagnostics import (
    diagnostic_context,
    diagnostic_id,
    failure,
    public_error,
    record,
)


def provider_error(body: Any) -> dict[str, Any]:
    error = body.get("error", body) if isinstance(body, dict) else {}
    if not isinstance(error, dict):
        error = {}
    code = str(error.get("code") or error.get("type") or "provider_error")
    # Do not retain arbitrary provider prose: compatible APIs can echo the complete prompt/key.
    descriptions = {
        "invalid_api_key": "服务商拒绝了认证信息",
        "insufficient_quota": "服务商额度不足",
        "rate_limit_exceeded": "请求超过服务商速率限制",
        "model_not_found": "服务商找不到所选模型",
        "context_length_exceeded": "请求超过模型上下文限制",
        "server_error": "模型服务内部错误",
        "invalid_request_error": "模型服务拒绝请求参数",
    }
    return {
        "error_code": code
        if len(code) <= 80 and code.replace("_", "").isalnum()
        else "provider_error",
        "error_description": descriptions.get(code, "模型服务返回错误"),
    }


class DiagnosticHttpClient(httpx.AsyncClient):
    def __init__(self, **kwargs):
        kwargs.setdefault("timeout", DEFAULT_TIMEOUT)
        kwargs.setdefault("limits", DEFAULT_CONNECTION_LIMITS)
        kwargs.setdefault("follow_redirects", True)
        super().__init__(**kwargs)

    async def send(self, request: httpx.Request, **kwargs: Any) -> httpx.Response:
        started = time.monotonic()
        retries = request.headers.get("x-stainless-retry-count", "0")
        retry_count = int(retries) if retries.isdigit() else 0
        record("info", "model_http_started", retry_count=retry_count, method=request.method)
        try:
            response = await super().send(request, **kwargs)
        except asyncio.CancelledError:
            record("info", "model_http_cancelled", retry_count=retry_count)
            raise
        except Exception as exc:
            failure(
                "model_http_failed",
                exc,
                level="warn",
                retry_count=retry_count,
                duration_ms=round((time.monotonic() - started) * 1000),
                reason="timeout" if isinstance(exc, httpx.TimeoutException) else "network",
            )
            raise
        fields = {
            "status_code": response.status_code,
            "provider_request_id": response.headers.get("x-request-id")
            or response.headers.get("request-id"),
            "retry_count": retry_count,
            "duration_ms": round((time.monotonic() - started) * 1000),
        }
        if response.is_error:
            # SDK itself reads error bodies before retries; don't log any of that content.
            await response.aread()
            try:
                fields.update(provider_error(response.json()))
            except ValueError:
                fields.update(error_description="模型服务返回了非 JSON 错误")
        record("warn" if response.is_error else "info", "model_http_response", **fields)
        return response


class DiagnosticSyncHttpClient(httpx.Client):
    """The context summarizer uses the SDK's synchronous client in a worker thread."""

    def __init__(self, **kwargs):
        kwargs.setdefault("timeout", DEFAULT_TIMEOUT)
        kwargs.setdefault("limits", DEFAULT_CONNECTION_LIMITS)
        kwargs.setdefault("follow_redirects", True)
        super().__init__(**kwargs)

    def send(self, request: httpx.Request, **kwargs: Any) -> httpx.Response:
        started = time.monotonic()
        retries = request.headers.get("x-stainless-retry-count", "0")
        retry_count = int(retries) if retries.isdigit() else 0
        with diagnostic_context(request_id=diagnostic_id(), operation="context_model"):
            record("info", "model_http_started", retry_count=retry_count)
            try:
                response = super().send(request, **kwargs)
                fields = {
                    "status_code": response.status_code,
                    "retry_count": retry_count,
                    "provider_request_id": response.headers.get("x-request-id"),
                    "duration_ms": round((time.monotonic() - started) * 1000),
                }
                if response.is_error:
                    response.read()
                    try:
                        fields.update(provider_error(response.json()))
                    except ValueError:
                        fields["error_description"] = "模型服务返回了非 JSON 错误"
                record("warn" if response.is_error else "info", "model_http_response", **fields)
                return response
            except Exception as exc:
                failure(
                    "model_http_failed",
                    exc,
                    level="warn",
                    retry_count=retry_count,
                    duration_ms=round((time.monotonic() - started) * 1000),
                    reason="timeout" if isinstance(exc, httpx.TimeoutException) else "network",
                )
                raise


class DiagnosedModelError(RuntimeError):
    def __init__(self, identifier: str):
        self.diagnostic_id = identifier
        super().__init__(public_error(identifier, "模型请求未完成，请检查模型设置或网络"))


class DiagnosticModel(Model):
    """Depend on SDK's public Model interface; no changes to the agent execution loop."""

    def __init__(self, delegate: Model, **context: Any):
        self.delegate = delegate
        self.context = context

    def _failed(self, error: Exception, started: float, streamed: bool) -> DiagnosedModelError:
        identifier = failure(
            "model_stream_failed" if streamed else "model_failed",
            error,
            duration_ms=round((time.monotonic() - started) * 1000),
            streamed=streamed,
            status_code=getattr(error, "status_code", None),
            provider_request_id=getattr(error, "request_id", None),
            **provider_error(getattr(error, "body", None)),
        )
        return DiagnosedModelError(identifier)

    async def get_response(self, *args, **kwargs):
        with diagnostic_context(**self.context, request_id=diagnostic_id()):
            return await self._get_response(*args, **kwargs)

    async def _get_response(self, *args, **kwargs):
        started = time.monotonic()
        try:
            response = await self.delegate.get_response(*args, **kwargs)
            record(
                "info", "model_completed", duration_ms=round((time.monotonic() - started) * 1000)
            )
            return response
        except asyncio.CancelledError:
            record("info", "model_cancelled")
            raise
        except Exception as exc:
            raise self._failed(exc, started, False) from exc

    async def stream_response(self, *args, **kwargs):
        with diagnostic_context(**self.context, request_id=diagnostic_id()):
            async for event in self._stream_response(*args, **kwargs):
                yield event

    async def _stream_response(self, *args, **kwargs):
        started = time.monotonic()
        completed = False
        try:
            async for event in self.delegate.stream_response(*args, **kwargs):
                if event.type == "response.completed":
                    completed = True
                yield event
            if not completed:
                raise RuntimeError("stream ended before response.completed")
            record(
                "info",
                "model_completed",
                streamed=True,
                duration_ms=round((time.monotonic() - started) * 1000),
            )
        except asyncio.CancelledError:
            record("info", "model_cancelled", streamed=True)
            raise
        except Exception as exc:
            raise self._failed(exc, started, True) from exc
