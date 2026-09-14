"""Working Memory 与长期 Memory 的可替换存储边界。"""

import asyncio
import json
import math
import re
from collections.abc import Sequence
from typing import Any, Protocol, runtime_checkable

from bit_agent.memory.models import (
    EmbeddingProfile,
    MemoryMatch,
    MemoryRecord,
    MemoryRecordStatus,
    MemoryScope,
    WorkingMemory,
)


@runtime_checkable
class WorkingMemoryStore(Protocol):
    """当前任务状态的存取协议。"""

    async def load(self, thread_id: str) -> WorkingMemory | None: ... #加载工作内存

    async def save( #保存工作内存
        self,
        memory: WorkingMemory,
        *,
        ttl_seconds: int | None = None,
    ) -> None: ...

    async def delete(self, thread_id: str) -> None: ... #删除工作内存


@runtime_checkable
class LongTermMemoryStore(Protocol):
    """已审核长期记忆的存取与语义搜索协议。"""

    async def find_by_key( #根据给定的键查找长期记忆
        self,
        *,
        scope: MemoryScope,
        memory_key: str,
        project_id: str | None,
        user_id: str | None,
    ) -> MemoryRecord | None: ...

    async def save(self, memory: MemoryRecord) -> None: ... #保存单条长期记忆

    async def save_many(self, memories: Sequence[MemoryRecord]) -> None: ... #保存多条长期记忆

    async def search( #根据给定的嵌入向量进行语义搜索
        self,
        embedding: Sequence[float],
        *,
        query_text: str | None = None,
        embedding_profile: EmbeddingProfile | None = None,
        project_id: str | None = None,
        user_id: str | None = None,
        limit: int = 5,
        semantic_weight: float = 1.0,
        lexical_weight: float = 0.0,
    ) -> list[MemoryMatch]: ...


class InMemoryWorkingMemoryStore:
    """用于单进程开发和单元测试的 Working Memory 存储。"""

    def __init__(self) -> None:
        self._items: dict[str, WorkingMemory] = {}
        self._lock = asyncio.Lock()

    async def load(self, thread_id: str) -> WorkingMemory | None: #加载工作内存
        async with self._lock: #获取锁
            memory = self._items.get(thread_id) #获取指定线程 ID 的工作内存
            return memory.model_copy(deep=True) if memory is not None else None #返回深拷贝的工作内存对象，如果不存在则返回 None

    async def save(
        self,
        memory: WorkingMemory,
        *,
        ttl_seconds: int | None = None,
    ) -> None:
        del ttl_seconds #忽略 ttl_seconds 参数，因为 InMemoryWorkingMemoryStore 不支持过期时间
        async with self._lock: #获取锁
            self._items[memory.thread_id] = memory.model_copy(deep=True) #保存深拷贝的工作内存对象到字典中

    async def delete(self, thread_id: str) -> None:
        async with self._lock:
            self._items.pop(thread_id, None) #从字典中删除指定线程 ID 的工作内存，如果不存在则忽略


class RedisWorkingMemoryStore:
    """把 Working Memory 作为 JSON 保存在独立 Redis 服务中。"""

    def __init__(
        self,
        client: Any,
        *,
        key_prefix: str = "bit-agent:working-memory:",
        default_ttl_seconds: int = 86_400,
    ) -> None:
        if default_ttl_seconds <= 0:
            raise ValueError("default_ttl_seconds 必须大于 0")
        self.client = client # Redis 客户端实例
        self.key_prefix = key_prefix # Redis 键前缀，用于区分不同类型的键
        self.default_ttl_seconds = default_ttl_seconds # 默认的过期时间（秒），用于保存工作内存时的 TTL

    @classmethod
    def from_url(
        cls,
        url: str,
        *,
        key_prefix: str = "bit-agent:working-memory:", # Redis 键前缀，用于区分不同类型的键
        default_ttl_seconds: int = 86_400,
    ) -> "RedisWorkingMemoryStore":
        try:
            from redis.asyncio import Redis
        except ImportError as exc:
            raise RuntimeError("使用 RedisWorkingMemoryStore 需要安装 memory 可选依赖") from exc
        client = Redis.from_url(url, decode_responses=True) #创建 Redis 客户端实例，使用指定的 URL 连接到 Redis 服务，并启用解码响应为字符串
        return cls(
            client,
            key_prefix=key_prefix,
            default_ttl_seconds=default_ttl_seconds,
        )

    async def load(self, thread_id: str) -> WorkingMemory | None: #根据 thread_id 从 Redis 读取对应的工作记忆，并还原成 WorkingMemory 对象。
        raw = await self.client.get(self._key(thread_id))
        if raw is None:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        return WorkingMemory.model_validate_json(raw)

    async def save( #这个函数用于：把 WorkingMemory 对象转换成 JSON，保存到 Redis，并设置过期时间。
        self,
        memory: WorkingMemory,
        *,
        ttl_seconds: int | None = None,
    ) -> None:
        ttl = ttl_seconds or self.default_ttl_seconds
        if ttl <= 0:
            raise ValueError("ttl_seconds 必须大于 0")
        await self.client.set(
            self._key(memory.thread_id),
            memory.model_dump_json(),
            ex=ttl,
        )

    async def delete(self, thread_id: str) -> None: #删除工作记忆
        await self.client.delete(self._key(thread_id))

    def _key(self, thread_id: str) -> str: #生成 Redis 键名
        return f"{self.key_prefix}{thread_id}"


class InMemoryLongTermMemoryStore: #用于自动化测试和本地调试，用来临时替代 PostgreSQL
    """保持与 PostgreSQL 实现相同语义的测试存储。"""

    def __init__(self) -> None:
        self._items: dict[str, MemoryRecord] = {}
        self._lock = asyncio.Lock()

    async def find_by_key(
        self,
        *,
        scope: MemoryScope,
        memory_key: str,
        project_id: str | None,
        user_id: str | None,
    ) -> MemoryRecord | None:
        async with self._lock:
            for memory in self._items.values():
                if ( #如果满足以下条件，则返回该 MemoryRecord 的深拷贝：
                    memory.status is MemoryRecordStatus.ACTIVE
                    and memory.parent_memory_id is None
                    and memory.scope is scope
                    and memory.memory_key == memory_key
                    and memory.project_id == project_id
                    and memory.user_id == user_id
                ):
                    return memory.model_copy(deep=True)
        return None

    async def save(self, memory: MemoryRecord) -> None:
        async with self._lock:
            self._items[memory.id] = memory.model_copy(deep=True)

    async def save_many(self, memories: Sequence[MemoryRecord]) -> None:
        async with self._lock:
            for memory in memories:
                self._items[memory.id] = memory.model_copy(deep=True)

    async def search(
        self,
        embedding: Sequence[float],
        *,
        query_text: str | None = None,
        embedding_profile: EmbeddingProfile | None = None,
        project_id: str | None = None,
        user_id: str | None = None,
        limit: int = 5,
        semantic_weight: float = 1.0,
        lexical_weight: float = 0.0,
    ) -> list[MemoryMatch]:
        if limit <= 0:
            raise ValueError("limit 必须大于 0")
        if semantic_weight + lexical_weight <= 0:
            raise ValueError("语义与关键词权重不能同时为 0")
        weight_total = semantic_weight + lexical_weight
        matches: list[MemoryMatch] = []
        async with self._lock:
            for memory in self._items.values():
                if memory.status is not MemoryRecordStatus.ACTIVE or memory.embedding is None:
                    continue
                if memory.scope is MemoryScope.PROJECT and memory.project_id != project_id:
                    continue
                if memory.scope is MemoryScope.USER and memory.user_id != user_id:
                    continue
                if embedding_profile is not None and memory.embedding_profile != embedding_profile:
                    continue
                if len(embedding) != len(memory.embedding):
                    continue
                semantic = cosine_similarity(embedding, memory.embedding)
                lexical = lexical_similarity(query_text or "", memory)
                combined = (
                    semantic * semantic_weight + lexical * lexical_weight
                ) / weight_total
                matched_by = ["semantic"]
                if lexical > 0:
                    matched_by.append("lexical")
                matches.append(
                    MemoryMatch(
                        memory=memory,
                        similarity=max(-1.0, min(1.0, combined)),
                        semantic_similarity=semantic,
                        lexical_similarity=lexical,
                        matched_by=matched_by,
                    )
                )
        return sorted(matches, key=lambda match: (-match.similarity, match.memory.id))[:limit]

    async def all(self) -> list[MemoryRecord]:
        """测试和本地调试使用的稳定快照。"""
        async with self._lock:
            return [self._items[key].model_copy(deep=True) for key in sorted(self._items)] #返回所有 MemoryRecord 的深拷贝列表，按键排序


def cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    """计算两个等长向量的余弦相似度。"""
    if len(left) != len(right):
        raise ValueError("Embedding 维度不一致")
    if not left:
        raise ValueError("Embedding 不能为空")
    dot = sum(a * b for a, b in zip(left, right, strict=True)) #计算两个向量的点积
    left_norm = math.sqrt(sum(value * value for value in left)) #计算左向量的范数
    right_norm = math.sqrt(sum(value * value for value in right)) #计算右向量的范数
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm) #计算余弦相似度，即点积除以两个向量范数的乘积


def lexical_similarity(query: str, memory: MemoryRecord) -> float:
    """对 memory_key、标签、标题和正文执行轻量关键词打分。"""
    normalized_query = query.strip().casefold() #将查询字符串去除首尾空格并转换为小写
    if not normalized_query: #如果查询字符串为空，则返回 0.0
        return 0.0
    if normalized_query in memory.memory_key.casefold(): #如果查询字符串在 memory_key 中，则返回 1.0
        return 1.0
    if normalized_query in memory.title.casefold(): #如果查询字符串在标题中，则返回 0.9
        return 0.9
    if any(normalized_query in tag.casefold() for tag in memory.tags): #如果查询字符串在标签中，则返回 0.8
        return 0.8
    if normalized_query in memory.content.casefold(): #如果查询字符串在正文中，则返回 0.7
        return 0.7

    query_tokens = _lexical_tokens(normalized_query) #将查询字符串分词为一组关键词
    memory_tokens = _lexical_tokens( #将 memory 的 memory_key、标题、正文和标签拼接为一个字符串，并分词为一组关键词
        " ".join((memory.memory_key, memory.title, memory.content, *memory.tags)).casefold() #将拼接后的字符串转换为小写
    )
    if not query_tokens or not memory_tokens: #如果查询关键词或 memory 关键词为空，则返回 0.0
        return 0.0
    return len(query_tokens & memory_tokens) / len(query_tokens) #计算查询关键词与 memory 关键词的交集占查询关键词的比例，作为轻量关键词相似度评分


def _lexical_tokens(text: str) -> set[str]: #将文本分词为一组关键词，支持英文、数字、下划线、点、连字符和中文字符。
    return set(re.findall(r"[a-z0-9_.-]+|[\u3400-\u9fff]", text)) #使用正则表达式匹配英文、数字、下划线、点、连字符和中文字符，并返回一个集合，去除重复的关键词


def encode_json(value: Any) -> str:
    """供数据库适配器稳定编码 JSON 字段。"""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")) #将 Python 对象编码为 JSON 字符串，确保非 ASCII 字符不被转义，并使用紧凑的分隔符（逗号和冒号）
