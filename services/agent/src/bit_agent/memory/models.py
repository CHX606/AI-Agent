"""Bit Agent 短期工作记忆与长期记忆的稳定数据模型。"""

import hashlib
from datetime import UTC, datetime
from enum import StrEnum
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def utc_now() -> datetime:
    """返回带时区的 UTC 时间，便于数据库和 JSON 稳定交换。"""
    return datetime.now(UTC)


class WorkingMemoryStatus(StrEnum):
    """当前任务在 Harness 中的生命周期状态。"""

    ACTIVE = "ACTIVE"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class TestStatus(StrEnum):
    """最近代码状态的验证情况。"""

    NOT_RUN = "NOT_RUN"
    NEEDS_VERIFICATION = "NEEDS_VERIFICATION"
    PASSED = "PASSED"
    FAILED = "FAILED"


class WorkingMemory(BaseModel):
    """一个 Agent 线程当前正在使用的结构化任务状态。"""

    model_config = ConfigDict(extra="forbid", validate_assignment=True)

    thread_id: str = Field(min_length=1)
    objective: str = Field(min_length=1, max_length=4_000)
    constraints: list[str] = Field(default_factory=list)
    current_plan: list[str] = Field(default_factory=list)
    files_read: list[str] = Field(default_factory=list)
    changed_files: list[str] = Field(default_factory=list)
    important_findings: list[str] = Field(default_factory=list)
    unresolved_errors: list[str] = Field(default_factory=list)
    latest_test_status: TestStatus = TestStatus.NOT_RUN
    basic_checks_passed: bool = False
    acceptance_status: Literal["NOT_RUN", "PASSED", "FAILED", "NOT_VERIFIED"] = "NOT_RUN"
    # 任务进度只在这里保存；对话历史和压缩摘要由 Context Manager 管理。
    has_unverified_changes: bool = False
    verification_paths: list[str] = Field(default_factory=list)
    applied_interaction_ids: list[str] = Field(default_factory=list)
    rounds: int = Field(default=0, ge=0)
    status: WorkingMemoryStatus = WorkingMemoryStatus.ACTIVE
    updated_at: datetime = Field(default_factory=utc_now)

    @field_validator(
        "constraints",
        "current_plan",
        "files_read",
        "changed_files",
        "important_findings",
        "unresolved_errors",
        "verification_paths",
        "applied_interaction_ids",
    )
    @classmethod
    def validate_unique_items(cls, values: list[str]) -> list[str]:
        normalized = [value.strip() for value in values]
        if any(not value for value in normalized):
            raise ValueError("Working Memory 列表不能包含空字符串")
        if len(normalized) != len(set(normalized)):
            raise ValueError("Working Memory 列表不能包含重复项")
        return normalized


class MemoryScope(StrEnum):
    """长期记忆可以影响的隔离范围。"""

    USER = "USER"
    PROJECT = "PROJECT"
    GLOBAL = "GLOBAL"


class MemoryKind(StrEnum):
    """长期记忆保存的知识类型。"""

    PREFERENCE = "PREFERENCE"
    FACT = "FACT"
    DECISION = "DECISION"
    EPISODE = "EPISODE"
    PROCEDURE = "PROCEDURE"


class MemoryRecordStatus(StrEnum):
    """长期记忆记录的可用状态。"""

    ACTIVE = "ACTIVE"
    SUPERSEDED = "SUPERSEDED"
    DELETED = "DELETED"


class EmbeddingProfile(BaseModel):
    """一组可相互比较的向量必须共享的模型身份。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    provider: str = Field(min_length=1, max_length=100)
    model: str = Field(min_length=1, max_length=200)
    dimensions: int = Field(gt=0, le=65_535)
    version: str = Field(default="1", min_length=1, max_length=100)

    @field_validator("provider", "model", "version")
    @classmethod
    def strip_profile_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Embedding Profile 字段不能为空")
        return normalized

    @property
    def id(self) -> str:
        raw = f"{self.provider}\0{self.model}\0{self.dimensions}\0{self.version}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


class MemorySourceReference(BaseModel):
    """长期记忆到评测证据或外部 Artifact 的可审计引用。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    run_id: str = Field(min_length=1)
    evidence_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    artifact_uri: str | None = Field(default=None, max_length=2_000)


class MemoryCandidate(BaseModel):
    """LLM 从一次已验证任务中提炼出的待审核记忆。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    scope: MemoryScope = MemoryScope.PROJECT
    kind: MemoryKind
    memory_key: str = Field(
        min_length=3,
        max_length=200,
        pattern=r"^[a-z][a-z0-9_.-]*$",
    )
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(min_length=1, max_length=50_000)
    applicability: str = Field(min_length=1, max_length=2_000)
    evidence_summary: str = Field(min_length=1, max_length=4_000)
    tags: list[str] = Field(default_factory=list, max_length=20)
    importance: float = Field(ge=0.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)

    @field_validator("scope", "kind", mode="before")
    @classmethod
    def normalize_enum_text(cls, value: object) -> object:
        return value.upper() if isinstance(value, str) else value

    @field_validator("memory_key", mode="before")
    @classmethod
    def normalize_memory_key(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        return value.strip().lower().replace(" ", "_")

    @field_validator("title", "content", "applicability", "evidence_summary")
    @classmethod
    def strip_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("MemoryCandidate 文本字段不能为空")
        return normalized

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, tags: list[str]) -> list[str]:
        normalized = sorted({tag.strip().lower() for tag in tags if tag.strip()})
        return normalized

    @property
    def embedding_text(self) -> str:
        """只组合语义检索真正需要的内容。"""
        return "\n".join(
            (
                self.title,
                self.content,
                f"适用条件：{self.applicability}",
            )
        )


class MemoryCandidateBatch(BaseModel):
    """LLM 一次巩固调用返回的候选集合。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    candidates: list[MemoryCandidate] = Field(default_factory=list)


class CompactedRunEvidence(BaseModel):
    """在交给记忆提炼模型之前经过确定性预算压缩的证据。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    run_id: str = Field(min_length=1)
    thread_id: str = Field(min_length=1)
    project_id: str | None = None
    user_id: str | None = None
    objective: str = Field(min_length=1)
    working_memory_summary: str = ""
    final_answer: str = ""
    changed_files: list[str] = Field(default_factory=list)
    tool_trace_summary: str = ""
    diff_summary: str = ""
    verification_summary: str = ""
    independently_verified: bool = False
    original_characters: int = Field(ge=0)
    compacted_characters: int = Field(ge=0)
    estimated_tokens: int = Field(ge=0)
    evidence_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class MemoryRecord(BaseModel):
    """通过 Harness 审核并可持久化、召回的长期记忆。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(default_factory=lambda: uuid4().hex, min_length=1)
    scope: MemoryScope
    kind: MemoryKind
    memory_key: str = Field(min_length=3, max_length=200)
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(min_length=1, max_length=50_000)
    applicability: str = Field(min_length=1, max_length=2_000)
    evidence_summary: str = Field(min_length=1, max_length=4_000)
    tags: list[str] = Field(default_factory=list)
    importance: float = Field(ge=0.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)
    project_id: str | None = None
    user_id: str | None = None
    source_run_ids: list[str] = Field(min_length=1)
    source_references: list[MemorySourceReference] = Field(default_factory=list)
    parent_memory_id: str | None = None
    chunk_index: int = Field(default=0, ge=0)
    chunk_count: int = Field(default=1, ge=1)
    content_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    embedding: list[float] | None = None
    embedding_profile: EmbeddingProfile | None = None
    status: MemoryRecordStatus = MemoryRecordStatus.ACTIVE
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    @model_validator(mode="after")
    def validate_scope_identity(self) -> "MemoryRecord":
        if self.scope is MemoryScope.PROJECT and not self.project_id:
            raise ValueError("PROJECT Memory 必须包含 project_id")
        if self.scope is MemoryScope.USER and not self.user_id:
            raise ValueError("USER Memory 必须包含 user_id")
        if self.scope is MemoryScope.PROJECT and self.user_id is not None:
            raise ValueError("PROJECT Memory 不能包含 user_id")
        if self.scope is MemoryScope.USER and self.project_id is not None:
            raise ValueError("USER Memory 不能包含 project_id")
        if self.scope is MemoryScope.GLOBAL and (
            self.project_id is not None or self.user_id is not None
        ):
            raise ValueError("GLOBAL Memory 不能绑定 project_id 或 user_id")
        if len(self.source_run_ids) != len(set(self.source_run_ids)):
            raise ValueError("source_run_ids 不能重复")
        if self.parent_memory_id is None and self.chunk_index != 0:
            raise ValueError("根 Memory 的 chunk_index 必须为 0")
        if self.parent_memory_id is not None and self.chunk_index == 0:
            raise ValueError("子 Memory 的 chunk_index 必须大于 0")
        if self.chunk_index > self.chunk_count:
            raise ValueError("chunk_index 不能大于 chunk_count")
        if self.embedding is None and self.embedding_profile is not None:
            raise ValueError("没有 embedding 时不能设置 embedding_profile")
        if self.embedding is not None:
            if self.embedding_profile is None:
                raise ValueError("有 embedding 时必须设置 embedding_profile")
            if len(self.embedding) != self.embedding_profile.dimensions:
                raise ValueError("Embedding 维度与 embedding_profile 不一致")
        expected_hash = _content_hash(self.content)
        if self.content_hash is None:
            object.__setattr__(self, "content_hash", expected_hash)
        elif self.content_hash != expected_hash:
            raise ValueError("content_hash 与 content 不一致")
        referenced_runs = {reference.run_id for reference in self.source_references}
        if not referenced_runs.issubset(self.source_run_ids):
            raise ValueError("source_references 必须引用 source_run_ids 中的运行")
        return self

    @property
    def embedding_text(self) -> str:
        return "\n".join((self.title, self.content, f"适用条件：{self.applicability}"))

    @classmethod
    def from_candidate(
        cls,
        candidate: MemoryCandidate,
        *,
        source_run_id: str,
        project_id: str | None,
        user_id: str | None,
        embedding: list[float] | None = None,
        embedding_profile: EmbeddingProfile | None = None,
        parent_memory_id: str | None = None,
        chunk_index: int = 0,
        chunk_count: int = 1,
        content: str | None = None,
        source_references: list[MemorySourceReference] | None = None,
    ) -> "MemoryRecord":
        return cls(
            scope=candidate.scope,
            kind=candidate.kind,
            memory_key=candidate.memory_key,
            title=candidate.title,
            content=content if content is not None else candidate.content,
            applicability=candidate.applicability,
            evidence_summary=candidate.evidence_summary,
            tags=candidate.tags,
            importance=candidate.importance,
            confidence=candidate.confidence,
            project_id=project_id if candidate.scope is MemoryScope.PROJECT else None,
            user_id=user_id if candidate.scope is MemoryScope.USER else None,
            source_run_ids=[source_run_id],
            source_references=source_references or [],
            parent_memory_id=parent_memory_id,
            chunk_index=chunk_index,
            chunk_count=chunk_count,
            embedding=embedding,
            embedding_profile=embedding_profile,
        )


class MemoryDisposition(StrEnum):
    """Harness 对一个候选的审核结论。"""

    ACCEPTED = "ACCEPTED"
    MERGED = "MERGED"
    REJECTED = "REJECTED"
    CONFLICT = "CONFLICT"


class MemoryReview(BaseModel):
    """一个候选从产生到写入决策的可审计记录。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    candidate: MemoryCandidate
    disposition: MemoryDisposition
    reasons: list[str] = Field(default_factory=list)
    memory_id: str | None = None


class ConsolidationStatus(StrEnum):
    """一次任务结束后的记忆巩固状态。"""

    COMPLETED = "COMPLETED"
    SKIPPED = "SKIPPED"
    FAILED = "FAILED"


class MemoryConsolidationResult(BaseModel):
    """任务结束后的候选、审核和写入结果。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    run_id: str = Field(min_length=1)
    status: ConsolidationStatus
    reviews: list[MemoryReview] = Field(default_factory=list)
    created: list[MemoryRecord] = Field(default_factory=list)
    updated: list[MemoryRecord] = Field(default_factory=list)
    error: str | None = None

    @model_validator(mode="after")
    def validate_error(self) -> "MemoryConsolidationResult":
        if self.status is ConsolidationStatus.FAILED and self.error is None:
            raise ValueError("失败的记忆巩固必须包含 error")
        if self.status is not ConsolidationStatus.FAILED and self.error is not None:
            raise ValueError("非失败的记忆巩固不能包含 error")
        return self


class VerifiedRunEvidence(BaseModel):
    """只在独立验证后交给 LLM 的任务证据摘要。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    run_id: str = Field(min_length=1)
    thread_id: str = Field(min_length=1)
    project_id: str | None = None
    user_id: str | None = None
    objective: str = Field(min_length=1)
    working_memory: WorkingMemory
    final_answer: str = ""
    changed_files: list[str] = Field(default_factory=list)
    tool_trace_summary: str = ""
    diff: str = ""
    verification_summary: str = ""
    source_artifact_uri: str | None = Field(default=None, max_length=2_000)
    independently_verified: bool = False


class MemoryMatch(BaseModel):
    """长期记忆语义检索的一项结果。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    memory: MemoryRecord
    similarity: float = Field(ge=-1.0, le=1.0)
    semantic_similarity: float | None = Field(default=None, ge=-1.0, le=1.0)
    lexical_similarity: float = Field(default=0.0, ge=0.0, le=1.0)
    matched_by: list[str] = Field(default_factory=list)


class MemoryContext(BaseModel):
    """准备注入模型、已经过 Token 预算控制的长期记忆。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    text: str = ""
    matches: list[MemoryMatch] = Field(default_factory=list)
    estimated_tokens: int = Field(default=0, ge=0)
    truncated: bool = False


def _content_hash(content: str) -> str:
    normalized = " ".join(content.split()).casefold()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()
