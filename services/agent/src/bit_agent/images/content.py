"""Responses image items also convert through the SDK's Chat Completions adapter."""

from typing import Any

from bit_agent.attachments import attachment_text_blocks

IMAGE_OBJECTIVE = "请查看上传的图片。"


def readable_objective(text: str, attachments: list[dict[str, str]] | None = None) -> str:
    return text.strip() or ("请查看上传的附件。" if attachments else IMAGE_OBJECTIVE)


def user_message(
    text: str,
    images: list[dict[str, str]] | None = None,
    attachments: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    if not images and not attachments:
        return {"role": "user", "content": text.strip()}
    content: list[dict[str, str]] = []
    if text.strip():
        content.append({"type": "input_text", "text": text.strip()})
    content.extend(
        {"type": "input_image", "image_url": image["data_url"], "detail": "auto"}
        for image in images or []
    )
    content.extend(attachment_text_blocks(attachments or []))
    return {"role": "user", "content": content}


def image_metadata(images: list[dict[str, str]]) -> list[dict[str, Any]]:
    result = []
    for image in images:
        encoded = image["data_url"].split(",", 1)[1]
        size = len(encoded) * 3 // 4 - len(encoded) + len(encoded.rstrip("="))
        result.append({"name": image["name"], "mime_type": image["mime_type"], "size": size})
    return result
