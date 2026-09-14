"""不依赖特定 tokenizer 的稳定 Token 预算与文本分块。"""

import math
import re

_CJK_PATTERN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_ASCII_WORD_PATTERN = re.compile(r"[A-Za-z0-9_]+|[^\sA-Za-z0-9_]")


def estimate_tokens(text: str) -> int:
    """保守估算中英混合文本 Token 数，用于 Harness 的硬预算。"""
    if not text:
        return 0
    cjk_count = len(_CJK_PATTERN.findall(text))
    remaining = _CJK_PATTERN.sub("", text)
    ascii_units = 0
    for token in _ASCII_WORD_PATTERN.findall(remaining):
        if token.isascii() and (token.isalnum() or "_" in token):
            ascii_units += max(1, math.ceil(len(token) / 4))
        else:
            ascii_units += 1
    return cjk_count + ascii_units


def truncate_to_token_budget(
    text: str,
    max_tokens: int,
    *,
    marker: str = "\n…[内容已按 Token 预算压缩]…\n",
) -> str:
    """同时保留首尾证据，避免只截断尾部而丢失最终错误。"""
    if max_tokens <= 0:
        return ""
    normalized = text.strip()
    if estimate_tokens(normalized) <= max_tokens:
        return normalized

    marker_tokens = estimate_tokens(marker)
    if marker_tokens >= max_tokens:
        return _take_prefix(normalized, max_tokens)
    content_budget = max(1, max_tokens - marker_tokens)
    head_budget = math.ceil(content_budget * 0.6)
    tail_budget = content_budget - head_budget
    head = _take_prefix(normalized, head_budget)
    tail = _take_suffix(normalized, tail_budget)
    return f"{head}{marker}{tail}".strip()


def split_text_by_token_budget(
    text: str,
    *,
    max_tokens: int,
    overlap_tokens: int = 0,
) -> list[str]:
    """优先按段落和行切分，超长单行才按字符边界切分。"""
    if max_tokens <= 0:
        raise ValueError("max_tokens 必须大于 0")
    if overlap_tokens < 0 or overlap_tokens >= max_tokens:
        raise ValueError("overlap_tokens 必须位于 [0, max_tokens) 范围")
    normalized = text.strip()
    if not normalized:
        return []
    if estimate_tokens(normalized) <= max_tokens:
        return [normalized]

    units = [unit.strip() for unit in re.split(r"\n{2,}|(?<=\n)", normalized) if unit.strip()]
    chunks: list[str] = []
    current = ""
    for unit in units:
        if estimate_tokens(unit) > max_tokens:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(_split_oversized_unit(unit, max_tokens))
            continue
        candidate = f"{current}\n{unit}".strip() if current else unit
        if estimate_tokens(candidate) <= max_tokens:
            current = candidate
            continue
        chunks.append(current)
        current = unit
    if current:
        chunks.append(current)

    if overlap_tokens == 0 or len(chunks) <= 1:
        return chunks
    with_overlap = [chunks[0]]
    for index in range(1, len(chunks)):
        overlap = _take_suffix(chunks[index - 1], overlap_tokens)
        combined = f"{overlap}\n{chunks[index]}".strip()
        with_overlap.append(_take_suffix(combined, max_tokens))
    return with_overlap


def _split_oversized_unit(text: str, max_tokens: int) -> list[str]:
    chunks: list[str] = []
    remaining = text
    while remaining:
        chunk = _take_prefix(remaining, max_tokens)
        if not chunk:
            break
        chunks.append(chunk)
        remaining = remaining[len(chunk) :].lstrip()
    return chunks


def _take_prefix(text: str, token_budget: int) -> str:
    if token_budget <= 0:
        return ""
    low = 0
    high = len(text)
    while low < high:
        middle = (low + high + 1) // 2
        if estimate_tokens(text[:middle]) <= token_budget:
            low = middle
        else:
            high = middle - 1
    return text[:low].rstrip()


def _take_suffix(text: str, token_budget: int) -> str:
    if token_budget <= 0:
        return ""
    low = 0
    high = len(text)
    while low < high:
        middle = (low + high + 1) // 2
        if estimate_tokens(text[len(text) - middle :]) <= token_budget:
            low = middle
        else:
            high = middle - 1
    return text[len(text) - low :].lstrip() if low else ""
