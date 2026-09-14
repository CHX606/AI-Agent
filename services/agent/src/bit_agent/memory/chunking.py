"""把一条长记忆转换为根记录和可独立召回的子块。"""

from pydantic import BaseModel, ConfigDict, Field, model_validator

from bit_agent.memory.budget import estimate_tokens, split_text_by_token_budget
from bit_agent.memory.models import (
    MemoryCandidate,
    MemoryRecord,
    MemorySourceReference,
)


class MemoryChunkingPolicy(BaseModel):
    """原子记忆保持单条；长 Episode/Procedure 才建立父子分块。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    chunk_threshold_tokens: int = Field(default=900, gt=0)
    max_chunk_tokens: int = Field(default=700, gt=0)
    overlap_tokens: int = Field(default=80, ge=0)

    @model_validator(mode="after")
    def validate_chunk_budgets(self) -> "MemoryChunkingPolicy":
        if self.max_chunk_tokens > self.chunk_threshold_tokens:
            raise ValueError("max_chunk_tokens 不能大于 chunk_threshold_tokens")
        if self.overlap_tokens >= self.max_chunk_tokens:
            raise ValueError("overlap_tokens 必须小于 max_chunk_tokens")
        return self


class MemoryChunker:
    """生成尚未写入向量的 MemoryRecord 集合。"""

    def __init__(self, policy: MemoryChunkingPolicy | None = None) -> None:
        self.policy = policy or MemoryChunkingPolicy()

    def build_records(
        self,
        candidate: MemoryCandidate,
        *,
        source_run_id: str,
        project_id: str | None,
        user_id: str | None,
        source_reference: MemorySourceReference,
    ) -> tuple[MemoryRecord, list[MemoryRecord]]:
        if estimate_tokens(candidate.content) <= self.policy.chunk_threshold_tokens:
            memory = MemoryRecord.from_candidate(
                candidate,
                source_run_id=source_run_id,
                project_id=project_id,
                user_id=user_id,
                source_references=[source_reference],
            )
            return memory, [memory]

        chunks = split_text_by_token_budget(
            candidate.content,
            max_tokens=self.policy.max_chunk_tokens,
            overlap_tokens=self.policy.overlap_tokens,
        )
        root = MemoryRecord.from_candidate(
            candidate,
            source_run_id=source_run_id,
            project_id=project_id,
            user_id=user_id,
            chunk_count=len(chunks),
            source_references=[source_reference],
        )
        children = [
            MemoryRecord.from_candidate(
                candidate,
                source_run_id=source_run_id,
                project_id=project_id,
                user_id=user_id,
                parent_memory_id=root.id,
                chunk_index=index,
                chunk_count=len(chunks),
                content=content,
                source_references=[source_reference],
            )
            for index, content in enumerate(chunks, start=1)
        ]
        return root, [root, *children]
