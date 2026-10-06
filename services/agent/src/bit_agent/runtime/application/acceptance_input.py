"""Independent verification reads user images as vision input, never base64 text."""

import json
from collections.abc import Mapping
from typing import Any

from bit_agent.images import image_metadata, user_message


def _metadata_projection(value: Any) -> Any:
    if isinstance(value, Mapping):
        if set(value) == {"name", "mime_type", "data_url"}:
            return image_metadata([dict(value)])[0]
        return {key: _metadata_projection(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_metadata_projection(child) for child in value]
    return value


def acceptance_input(context: dict) -> tuple[str, list[dict[str, Any]]]:
    packet = json.dumps(_metadata_projection(context), ensure_ascii=False)
    if len(packet.encode("utf-8")) > 256_000:
        raise ValueError("验收上下文过大，请分拆任务；不会静默丢弃原始需求")
    history = []
    for request in context.get("requirements", {}).get("user_requests", []):
        if request.get("images"):
            history.append(user_message(request.get("objective", ""), request["images"]))
        for update in request.get("updates", []):
            if update.get("images"):
                history.append(user_message(update.get("text", ""), update["images"]))
    return packet, history
