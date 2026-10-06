"""Keep binary images out of text estimates while preserving visual summary inputs."""

from collections.abc import Mapping, Sequence
from typing import Any

# A transport-independent estimate, not a provider's billable token count.
IMAGE_TOKEN_ESTIMATE = 4_096


def image_blocks(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, Mapping):
        if value.get("type") == "input_image" and value.get("image_url"):
            return [dict(value)]
        return [block for child in value.values() for block in image_blocks(child)]
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [block for child in value for block in image_blocks(child)]
    return []


def text_projection(value: Any) -> Any:
    if isinstance(value, Mapping):
        if value.get("type") == "input_image":
            return {
                "type": "input_image",
                "detail": value.get("detail", "auto"),
                "image_url": "[image supplied as visual input]",
            }
        return {str(key): text_projection(child) for key, child in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [text_projection(child) for child in value]
    return value


def summary_content(text: str, images: list[dict[str, Any]]) -> str | list[dict[str, Any]]:
    if not images:
        return text
    return [{"type": "input_text", "text": text}, *images]
