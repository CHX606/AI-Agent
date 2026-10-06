"""Build bounded text batches with the matching images for visual summarization."""

from typing import Any

from bit_agent.context.multimodal import image_blocks
from bit_agent.context.serialization import serialize_items, to_json_value
from bit_agent.memory.budget import split_text_by_token_budget


def summary_sources(items: list[Any], max_tokens: int) -> list[tuple[str, list[dict[str, Any]]]]:
    normalized = to_json_value(items)
    if not image_blocks(normalized):
        return [
            (source, [])
            for source in split_text_by_token_budget(
                serialize_items(items),
                max_tokens=max_tokens,
            )
        ]
    result = []
    for item in normalized:
        images = image_blocks(item)
        sources = split_text_by_token_budget(serialize_items([item]), max_tokens=max_tokens)
        result.extend(
            (source, images if index == 0 else []) for index, source in enumerate(sources)
        )
    return result
