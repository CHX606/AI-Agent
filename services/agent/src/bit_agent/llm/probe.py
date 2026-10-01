"""“测试连接”：用一次极小的真实请求确认地址、密钥、模型和接口类型可用。"""

import asyncio
import time
from typing import Any

from openai import APIConnectionError, APIStatusError, APITimeoutError, OpenAI

from bit_agent.llm.client import MODEL_APIS

# 任务离不开工具调用，所以测试请求带一个工具定义：服务不支持工具时在这里就能发现。
_TOOL_DESCRIPTION = "连接测试用的占位工具，不需要调用"
_STATUS_HINTS = {
    400: "服务拒绝了请求参数，可能不支持这种接口或工具调用",
    401: "API Key 被拒绝",
    403: "没有权限使用这个模型",
    404: "地址或模型名不对，或者服务不提供这种接口",
    405: "服务不提供这种接口",
    429: "请求过于频繁或额度不足",
}


def _ping(client: OpenAI, model: str, api: str) -> None:
    if api == "chat_completions":
        client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "ping"}],
            tools=[
                {
                    "type": "function",
                    "function": {
                        "name": "noop",
                        "description": _TOOL_DESCRIPTION,
                        "parameters": {"type": "object", "properties": {}},
                    },
                }
            ],
            max_tokens=16,
        )
        return
    client.responses.create(
        model=model,
        input="ping",
        tools=[
            {
                "type": "function",
                "name": "noop",
                "description": _TOOL_DESCRIPTION,
                "parameters": {"type": "object", "properties": {}},
            }
        ],
        max_output_tokens=16,
    )


async def probe_model(
    base_url: str, model: str, api_key: str, api: str = "auto", *, timeout: float = 20.0
) -> dict[str, Any]:
    """api 为 auto 时依次尝试 Responses 和 Chat Completions，返回第一个可用的。"""
    candidates = list(MODEL_APIS) if api == "auto" else [api]
    if any(item not in MODEL_APIS for item in candidates):
        raise ValueError("接口类型只能是 auto、responses 或 chat_completions")
    client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout, max_retries=0)
    attempts: list[dict[str, Any]] = []
    try:
        for candidate in candidates:
            started = time.monotonic()
            try:
                await asyncio.to_thread(_ping, client, model, candidate)
            except APIStatusError as exc:
                attempts.append(
                    {
                        "api": candidate,
                        "status_code": exc.status_code,
                        "message": _STATUS_HINTS.get(exc.status_code, "模型服务返回错误"),
                    }
                )
                # 认证和权限问题换一种接口也不会好，直接报告。
                if exc.status_code in {401, 403}:
                    break
                continue
            except (APIConnectionError, APITimeoutError) as exc:
                reason = "连接超时" if isinstance(exc, APITimeoutError) else "无法连接到接口地址"
                return {
                    "ok": False,
                    "api": None,
                    "message": f"{reason}，请检查地址、网络或代理设置",
                    "attempts": attempts,
                }
            return {
                "ok": True,
                "api": candidate,
                "latency_ms": round((time.monotonic() - started) * 1000),
                "message": "连接成功，模型可以接收带工具的请求",
                "attempts": attempts,
            }
    finally:
        client.close()
    last = attempts[-1] if attempts else {"message": "没有可尝试的接口"}
    return {"ok": False, "api": None, "message": last["message"], "attempts": attempts}
