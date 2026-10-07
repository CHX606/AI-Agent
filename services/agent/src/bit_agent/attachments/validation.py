"""Validate bounded attachment data before persistence or model invocation."""

import base64
import binascii
import re
from pathlib import PureWindowsPath
from typing import Any

from .document_text import MAX_TEXT_CHARS, extract_text

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_TOTAL_BYTES = 20 * 1024 * 1024


def attachment_bytes(file: dict[str, Any]) -> bytes:
    mime, value = file.get("mime_type"), file.get("data_url")
    if (
        not isinstance(mime, str)
        or len(mime) > 127
        or not re.fullmatch(r"[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+", mime)
    ):
        raise ValueError("附件类型不正确")
    prefix = f"data:{mime};base64,"
    if not isinstance(value, str) or not value.startswith(prefix):
        raise ValueError("附件类型与数据不一致")
    encoded = value[len(prefix) :]
    if len(encoded) > ((MAX_FILE_BYTES + 2) // 3) * 4:
        raise ValueError("单个附件不能超过 5 MiB")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("附件必须使用规范的 base64 数据") from exc
    if base64.b64encode(data).decode() != encoded or len(data) > MAX_FILE_BYTES:
        raise ValueError("附件数据过大或 base64 不规范")
    return data


def _validated_file(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"name", "mime_type", "data_url"}:
        raise ValueError("附件需要文件名、类型和数据")
    name = value["name"]
    if not isinstance(name, str) or not name.strip() or len(name) > 255:
        raise ValueError("附件文件名不正确")
    if re.search(r"[\x00-\x1f\x7f-\x9f]", name) or PureWindowsPath(name).name != name:
        raise ValueError("附件文件名必须是 basename")
    if name.strip() in {".", ".."} or PureWindowsPath(name).drive:
        raise ValueError("附件文件名必须是 basename")
    attachment_bytes(value)
    return {**value, "name": name.strip()}


def validate_attachments(value: Any) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 5:
        raise ValueError("每条消息最多添加 5 个附件")
    files = [_validated_file(file) for file in value]
    validate_upload_limits([], files)
    length = 0
    for file in files:
        length += len(extract_text(file["name"], attachment_bytes(file)))
        if length > MAX_TEXT_CHARS:
            raise ValueError("附件正文合计超过 200000 字符，请拆分后上传")
    return files


def validate_upload_limits(images: list[dict[str, str]], files: list[dict[str, str]]) -> None:
    if not files:
        return
    uploads = [*images, *files]
    if len(uploads) > 5:
        raise ValueError("图片与附件每次合计最多 5 个")
    sizes = [len(base64.b64decode(file["data_url"].split(",", 1)[1])) for file in uploads]
    if sum(sizes) > MAX_TOTAL_BYTES:
        raise ValueError("图片与附件总大小不能超过 20 MiB")
