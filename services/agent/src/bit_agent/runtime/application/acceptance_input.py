"""Independent verification receives original user images and attachment text."""

import json
from collections.abc import Mapping
from typing import Any

from bit_agent.attachments import attachment_metadata
from bit_agent.images import image_metadata, user_message


def _metadata_projection(value: Any) -> Any:
    if isinstance(value, Mapping):
        if set(value) == {"name", "mime_type", "data_url"}:
            metadata = (
                image_metadata
                if str(value["mime_type"]).startswith("image/")
                else attachment_metadata
            )
            return metadata([dict(value)])[0]
        return {key: _metadata_projection(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_metadata_projection(child) for child in value]
    return value


def _upload_message(request: dict[str, Any], text_key: str) -> list[dict[str, Any]]:
    images, attachments = request.get("images"), request.get("attachments")
    if not images and not attachments:
        return []
    return [user_message(request.get(text_key, ""), images, attachments)]


def acceptance_input(context: dict) -> tuple[str, list[dict[str, Any]]]:
    packet = json.dumps(_metadata_projection(context), ensure_ascii=False)
    if len(packet.encode("utf-8")) > 256_000:
        raise ValueError("验收上下文过大，请分拆任务；不会静默丢弃原始需求")
    history = []
    for request in context.get("requirements", {}).get("user_requests", []):
        history.extend(_upload_message(request, "objective"))
        for update in request.get("updates", []):
            history.extend(_upload_message(update, "text"))
    return packet, history
