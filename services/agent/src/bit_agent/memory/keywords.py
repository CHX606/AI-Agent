"""长期记忆的关键词切分与匹配度，不依赖 Embedding 服务。

中文没有空格分词：一段连续汉字切成相邻两字的片段（“测试失败” → 测试、试失、失败），
这样两个字的常见词也能命中；英文和数字按单词切分并转成小写。
"""

import re
from collections.abc import Iterable

from bit_agent.memory.models import MemoryRecord

_CJK_RUN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")
_WORD = re.compile(r"[a-z0-9]+")
# 几乎不携带信息的虚词；含这些字的两字片段不作为关键词。
_CJK_STOP_CHARS = frozenset("的了吗呢吧啊着过和与及或把被是在也都就这那个")
_ASCII_STOP_WORDS = frozenset(
    (
        "a an and are as at be by for from if in into is it of on or so that the this to was with"
    ).split()
)
# 长查询只要求命中其中几个关键词；否则一整段任务描述几乎不可能“全部命中”。
_COVERAGE_TARGET = 6
_MAX_QUERY_TOKENS = 64


def keyword_tokens(text: str) -> list[str]:
    """按出现顺序返回去重后的关键词。"""
    lowered = text.casefold()
    tokens: list[str] = []
    for word in _WORD.findall(lowered):
        if len(word) >= 2 and word not in _ASCII_STOP_WORDS:
            tokens.append(word)
    for run in _CJK_RUN.findall(lowered):
        if len(run) == 1:
            if run not in _CJK_STOP_CHARS:
                tokens.append(run)
            continue
        for index in range(len(run) - 1):
            pair = run[index : index + 2]
            if not (_CJK_STOP_CHARS & set(pair)):
                tokens.append(pair)
    return list(dict.fromkeys(tokens))


def query_tokens(text: str) -> list[str]:
    return keyword_tokens(text)[:_MAX_QUERY_TOKENS]


def memory_fields(memory: MemoryRecord) -> dict[str, str]:
    """参与检索的字段；键名和标题权重更高，由调用方决定。"""
    return {
        "keys": memory.memory_key.replace(".", " ").replace("_", " ").replace("-", " "),
        "title": memory.title,
        "tags": " ".join(memory.tags),
        "body": f"{memory.content}\n{memory.applicability}",
    }


def indexed_text(text: str) -> str:
    """写入全文索引的文本：关键词用空格隔开，数据库按空格切分即可。"""
    return " ".join(keyword_tokens(text))


def keyword_coverage(tokens: Iterable[str], memory: MemoryRecord) -> float:
    """查询关键词在这条记忆中命中的比例，0 到 1。"""
    wanted = list(dict.fromkeys(tokens))
    if not wanted:
        return 0.0
    present = set(keyword_tokens(" ".join(memory_fields(memory).values())))
    hits = sum(1 for token in wanted if token in present)
    return min(1.0, hits / min(len(wanted), _COVERAGE_TARGET))


def is_searchable(memory: MemoryRecord) -> bool:
    """长记忆的根记录只作目录，参与检索的是它拆出的分块；与 Embedding 选择一致。"""
    return not (memory.parent_memory_id is None and memory.chunk_count > 1)
