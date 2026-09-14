"""把 SDK 输出项稳定地转换为可计数、可总结的 JSON。"""

import json
from collections.abc import Mapping, Sequence
from typing import Any

from bit_agent.memory.budget import estimate_tokens


def to_json_value(value: Any) -> Any:
    """兼容 dict、Pydantic SDK 对象和测试中的 SimpleNamespace。"""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Mapping):
        return {str(key): to_json_value(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [to_json_value(item) for item in value]
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            return to_json_value(model_dump(mode="json"))
        except TypeError:
            return to_json_value(model_dump())
    attributes = getattr(value, "__dict__", None)
    if isinstance(attributes, dict):
        return {
            str(key): to_json_value(item)
            for key, item in attributes.items()
            if not str(key).startswith("_")
        }
    return str(value)


def serialize_items(items: Sequence[Any]) -> str:
    return json.dumps(to_json_value(items), ensure_ascii=False, separators=(",", ":"))


def estimate_context_tokens(
    items: Sequence[Any],
    tools: Sequence[Mapping[str, Any]],
) -> int:
    """估算消息、响应项和 Tool Schema 共同占用的输入 Token。"""
    return estimate_tokens(serialize_items(items)) + estimate_tokens(serialize_items(tools))
