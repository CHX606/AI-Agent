"""长期记忆 Embedding 的提供者与召回服务。"""

import asyncio
from collections.abc import Sequence
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field, model_validator

from bit_agent.memory.budget import estimate_tokens, truncate_to_token_budget
from bit_agent.memory.models import (
    EmbeddingProfile,
    MemoryContext,
    MemoryMatch,
)
from bit_agent.memory.store import LongTermMemoryStore


@runtime_checkable
class EmbeddingProvider(Protocol):
    """把文本转换为同一维度向量。"""

    async def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


class OpenAIEmbeddingProvider:
    """复用 OpenAI 兼容客户端生成长期记忆向量。"""

    def __init__(
        self,
        client: Any,
        model: str,
        *,
        dimensions: int | None = None,
        request_timeout_seconds: float = 30.0,
        provider_name: str = "openai-compatible",
        version: str = "1",
    ) -> None:
        if not model.strip():
            raise ValueError("Embedding model 不能为空")
        if dimensions is not None and dimensions <= 0:
            raise ValueError("Embedding dimensions 必须大于 0")
        if request_timeout_seconds <= 0:
            raise ValueError("request_timeout_seconds 必须大于 0")
        self.client = client
        self.model = model
        self.dimensions = dimensions
        self.request_timeout_seconds = request_timeout_seconds
        self.provider_name = provider_name
        self.version = version

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        normalized = [text.strip() for text in texts]
        if not normalized or any(not text for text in normalized):
            raise ValueError("Embedding 输入不能为空")
        request: dict[str, Any] = {
            "model": self.model,
            "input": normalized,
            "timeout": self.request_timeout_seconds,
        }
        if self.dimensions is not None:
            request["dimensions"] = self.dimensions
        response = await asyncio.to_thread(self.client.embeddings.create, **request)
        ordered = sorted(response.data, key=lambda item: item.index)
        return [list(item.embedding) for item in ordered]

    def profile_for_dimensions(self, dimensions: int) -> EmbeddingProfile:
        if self.dimensions is not None and dimensions != self.dimensions:
            raise ValueError("Embedding 服务返回的维度与配置不一致")
        return EmbeddingProfile(
            provider=self.provider_name,
            model=self.model,
            dimensions=dimensions,
            version=self.version,
        )


class MemoryRetrievalPolicy(BaseModel):
    """限制长期记忆注入量，避免向量搜索重新撑爆 Context。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    candidate_limit: int = Field(default=40, gt=0, le=200)
    limit: int = Field(default=8, gt=0, le=50)
    minimum_similarity: float = Field(default=0.55, ge=-1.0, le=1.0)
    max_context_tokens: int = Field(default=1_800, gt=0)
    max_memory_tokens: int = Field(default=500, gt=0)
    max_chunks_per_parent: int = Field(default=2, gt=0, le=10)
    semantic_weight: float = Field(default=0.8, ge=0.0, le=1.0)
    lexical_weight: float = Field(default=0.2, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def validate_retrieval_budget(self) -> "MemoryRetrievalPolicy":
        if self.limit > self.candidate_limit:
            raise ValueError("limit 不能大于 candidate_limit")
        if self.max_memory_tokens > self.max_context_tokens:
            raise ValueError("max_memory_tokens 不能大于 max_context_tokens")
        if self.semantic_weight + self.lexical_weight <= 0:
            raise ValueError("语义与关键词权重不能同时为 0")
        return self


class MemoryRetriever:
    """以项目/用户范围过滤后执行少量语义召回。"""

    def __init__(
        self,
        store: LongTermMemoryStore,
        embedding_provider: EmbeddingProvider,
        *,
        policy: MemoryRetrievalPolicy | None = None,
    ) -> None:
        self.store = store
        self.embedding_provider = embedding_provider
        self.policy = policy or MemoryRetrievalPolicy()

    async def retrieve(
        self,
        query: str,
        *,
        project_id: str | None = None,
        user_id: str | None = None,
    ) -> list[MemoryMatch]:
        if not query.strip():
            return []
        vectors = await self.embedding_provider.embed([query])
        if len(vectors) != 1 or not vectors[0]:
            raise ValueError("EmbeddingProvider 没有返回查询向量")
        profile = resolve_embedding_profile(self.embedding_provider, vectors[0])
        matches = await self.store.search(
            vectors[0],
            query_text=query,
            embedding_profile=profile,
            project_id=project_id,
            user_id=user_id,
            limit=self.policy.candidate_limit,
            semantic_weight=self.policy.semantic_weight,
            lexical_weight=self.policy.lexical_weight,
        )
        selected: list[MemoryMatch] = []
        used_tokens = 0
        parent_counts: dict[str, int] = {}
        for match in matches:
            if match.similarity < self.policy.minimum_similarity:
                continue
            logical_id = match.memory.parent_memory_id or match.memory.id
            if parent_counts.get(logical_id, 0) >= self.policy.max_chunks_per_parent:
                continue
            memory_tokens = min(
                estimate_tokens(match.memory.content),
                self.policy.max_memory_tokens,
            )
            if selected and used_tokens + memory_tokens > self.policy.max_context_tokens:
                continue
            selected.append(match)
            used_tokens += memory_tokens
            parent_counts[logical_id] = parent_counts.get(logical_id, 0) + 1
            if len(selected) >= self.policy.limit:
                break
        return selected

    async def build_context(
        self,
        query: str,
        *,
        project_id: str | None = None,
        user_id: str | None = None,
    ) -> MemoryContext:
        matches = await self.retrieve(
            query,
            project_id=project_id,
            user_id=user_id,
        )
        sections: list[str] = []
        context_matches: list[MemoryMatch] = []
        truncated = False
        for match in matches:
            content = truncate_to_token_budget(
                match.memory.content,
                self.policy.max_memory_tokens,
            )
            truncated = truncated or content != match.memory.content.strip()
            section = "\n".join(
                (
                    f"[Memory {match.memory.memory_key}]",
                    f"标题：{match.memory.title}",
                    f"内容：{content}",
                    f"适用条件：{match.memory.applicability}",
                )
            )
            separator_tokens = estimate_tokens("\n\n") if sections else 0
            used_tokens = estimate_tokens("\n\n".join(sections))
            remaining = self.policy.max_context_tokens - used_tokens - separator_tokens
            if remaining <= 0:
                truncated = True
                break
            bounded_section = truncate_to_token_budget(section, remaining)
            truncated = truncated or bounded_section != section
            if not bounded_section:
                break
            sections.append(bounded_section)
            context_matches.append(match)
            if bounded_section != section:
                break
        text = "\n\n".join(sections)
        return MemoryContext(
            text=text,
            matches=context_matches,
            estimated_tokens=estimate_tokens(text),
            truncated=truncated,
        )


def resolve_embedding_profile(
    provider: EmbeddingProvider,
    vector: Sequence[float],
) -> EmbeddingProfile:
    resolver = getattr(provider, "profile_for_dimensions", None)
    if callable(resolver):
        return resolver(len(vector))
    return EmbeddingProfile(
        provider=type(provider).__module__,
        model=type(provider).__qualname__,
        dimensions=len(vector),
        version="1",
    )
