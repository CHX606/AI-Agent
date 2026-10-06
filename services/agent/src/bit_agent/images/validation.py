"""Reject invalid or oversized upload data before saving it or invoking a model."""

import base64
import binascii
import re
from pathlib import PureWindowsPath
from typing import Any

from .gif import single_frame_gif

MAX_INPUT_BYTES = 28 * 1024 * 1024
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_TOTAL_BYTES = 20 * 1024 * 1024
MIME_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}


def _image_bytes(image: dict[str, Any]) -> bytes:
    mime, value = image.get("mime_type"), image.get("data_url")
    if not isinstance(mime, str) or mime not in MIME_TYPES or not isinstance(value, str):
        raise ValueError("图片仅支持 PNG、JPEG、WebP 和非动画 GIF")
    prefix = f"data:{mime};base64,"
    if not value.startswith(prefix) or len(value) > len(prefix) + ((MAX_IMAGE_BYTES + 2) // 3) * 4:
        raise ValueError("图片数据格式无效或超过单张 5 MiB 上限")
    encoded = value[len(prefix) :]
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("图片必须使用规范的 base64 数据") from exc
    if (
        not decoded
        or len(decoded) > MAX_IMAGE_BYTES
        or base64.b64encode(decoded).decode() != encoded
    ):
        raise ValueError("图片数据为空、过大或 base64 不规范")
    return decoded


def _signature_matches(mime: str, data: bytes) -> bool:
    if mime == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if mime == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if mime == "image/webp":
        return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    return data[:6] in {b"GIF87a", b"GIF89a"} and single_frame_gif(data)


def validate_images(value: Any) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 5:
        raise ValueError("每条消息最多上传 5 张图片")
    images, total = [], 0
    for image in value:
        if not isinstance(image, dict) or set(image) != {"name", "mime_type", "data_url"}:
            raise ValueError("图片需要文件名、类型和数据")
        name = image["name"]
        if (
            not isinstance(name, str)
            or not 1 <= len(name) <= 255
            or re.search(r"[\x00-\x1f\x7f-\x9f]", name)
        ):
            raise ValueError("图片文件名无效")
        if PureWindowsPath(name).name != name or name in {".", ".."}:
            raise ValueError("图片文件名必须是 basename")
        data = _image_bytes(image)
        if not _signature_matches(image["mime_type"], data):
            raise ValueError("图片类型与内容不一致，或 GIF 包含动画")
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise ValueError("每条消息图片合计不能超过 20 MiB")
        images.append(dict(image))
    return images
