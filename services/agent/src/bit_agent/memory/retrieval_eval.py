"""长期记忆召回质量的确定性离线评测。"""

from pydantic import BaseModel, ConfigDict, Field, model_validator

from bit_agent.memory.embedding import MemoryRetriever


class MemoryRetrievalCase(BaseModel):
    """一条查询及其应该召回的逻辑 Memory Key。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str = Field(min_length=1, max_length=200)
    query: str = Field(min_length=1, max_length=4_000)
    expected_memory_keys: list[str] = Field(min_length=1)
    project_id: str | None = None
    user_id: str | None = None

    @model_validator(mode="after")
    def validate_expected_keys(self) -> "MemoryRetrievalCase":
        normalized = [key.strip() for key in self.expected_memory_keys]
        if any(not key for key in normalized):
            raise ValueError("expected_memory_keys 不能包含空值")
        if len(normalized) != len(set(normalized)):
            raise ValueError("expected_memory_keys 不能重复")
        object.__setattr__(self, "expected_memory_keys", normalized)
        return self


class MemoryRetrievalCaseResult(BaseModel):
    """单条召回用例的 Recall 与 Reciprocal Rank。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str
    retrieved_memory_keys: list[str] = Field(default_factory=list)
    recall: float = Field(ge=0.0, le=1.0)
    reciprocal_rank: float = Field(ge=0.0, le=1.0)


class MemoryRetrievalEvalResult(BaseModel):
    """一组召回用例的聚合质量指标。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    cases: list[MemoryRetrievalCaseResult] = Field(default_factory=list)
    recall_at_k: float = Field(ge=0.0, le=1.0)
    mean_reciprocal_rank: float = Field(ge=0.0, le=1.0)


async def evaluate_memory_retrieval(
    retriever: MemoryRetriever,
    cases: list[MemoryRetrievalCase],
) -> MemoryRetrievalEvalResult:
    """运行真实 Retriever，避免只凭主观感觉调整召回参数。"""
    results: list[MemoryRetrievalCaseResult] = []
    for case in cases:
        matches = await retriever.retrieve(
            case.query,
            project_id=case.project_id,
            user_id=case.user_id,
        )
        retrieved = [match.memory.memory_key for match in matches]
        expected = set(case.expected_memory_keys)
        recall = len(expected.intersection(retrieved)) / len(expected)
        reciprocal_rank = 0.0
        for rank, memory_key in enumerate(retrieved, start=1):
            if memory_key in expected:
                reciprocal_rank = 1.0 / rank
                break
        results.append(
            MemoryRetrievalCaseResult(
                name=case.name,
                retrieved_memory_keys=retrieved,
                recall=recall,
                reciprocal_rank=reciprocal_rank,
            )
        )

    count = len(results)
    return MemoryRetrievalEvalResult(
        cases=results,
        recall_at_k=(sum(result.recall for result in results) / count if count else 0.0),
        mean_reciprocal_rank=(
            sum(result.reciprocal_rank for result in results) / count if count else 0.0
        ),
    )
