"""桌面任务的长期记忆：任务开始前召回本项目的相关经验，独立验收通过后在后台提炼新经验。

只有独立验收判定 PASSED 的任务才会写入记忆；检索只用关键词，不需要 Embedding 服务。
"""

import json
import os
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, Protocol

from bit_agent.agent.result import AgentRunResult, AgentRunStatus
from bit_agent.memory import (
    LongTermMemoryStore,
    MemoryCandidateExtractor,
    MemoryConsolidationResult,
    MemoryConsolidator,
    MemoryRecord,
    MemoryRetriever,
    VerifiedRunEvidence,
)

_MAX_TRACE_CALLS = 80
_MAX_VERIFICATION_CHARACTERS = 4_000


class ManagedMemoryStore(LongTermMemoryStore, Protocol):
    async def list_memories(self, project_id: str | None = None) -> list[MemoryRecord]: ...
    async def delete(self, memory_id: str) -> bool: ...
    def close(self) -> None: ...


def project_id_for(root: Path) -> str:
    """同一个目录在不同写法下（大小写、斜杠）得到同一个项目编号。"""
    return os.path.normcase(str(root.resolve())).replace("\\", "/")


class ProjectMemory:
    def __init__(
        self,
        store: ManagedMemoryStore,
        extractor_factory: Callable[[], MemoryCandidateExtractor],
    ) -> None:
        self.store = store
        self.extractor_factory = extractor_factory

    def retriever(self) -> MemoryRetriever:
        return MemoryRetriever(self.store)

    async def learn(
        self, task: dict[str, Any], result: AgentRunResult, patches: Sequence[str]
    ) -> MemoryConsolidationResult | None:
        """任务没有通过独立验收时返回 None，不调用模型。"""
        evidence = run_evidence(task, result, patches)
        if evidence is None:
            return None
        return await MemoryConsolidator(self.extractor_factory(), self.store).consolidate(evidence)

    async def list_memories(self, workspace_root: str | None = None) -> list[dict[str, Any]]:
        project = project_id_for(Path(workspace_root)) if workspace_root else None
        return [public_memory(memory) for memory in await self.store.list_memories(project)]

    async def delete(self, memory_id: str) -> bool:
        return await self.store.delete(memory_id)

    def close(self) -> None:
        self.store.close()


def run_evidence(
    task: dict[str, Any], result: AgentRunResult, patches: Sequence[str]
) -> VerifiedRunEvidence | None:
    if (
        result.status is not AgentRunStatus.COMPLETED
        or result.acceptance_status != "PASSED"
        or result.working_memory is None
    ):
        return None
    trace = [
        f"#{call.round} {call.tool_name} {call.status}"
        + (f" {call.error.code}" if call.error else "")
        for call in result.tool_calls[-_MAX_TRACE_CALLS:]
    ]
    verification = [
        f"{call.tool_name} {call.status}: "
        + json.dumps(call.output, ensure_ascii=False, default=str)[:_MAX_VERIFICATION_CHARACTERS]
        for call in result.tool_calls
        if call.tool_name in {"verify_project", "verify_task"}
    ]
    return VerifiedRunEvidence(
        run_id=result.run_id or task["task_id"],
        thread_id=task["session_id"],
        project_id=project_id_for(Path(task["workspace_root"])),
        objective=task["objective"],
        working_memory=result.working_memory,
        final_answer=result.final_answer or "",
        changed_files=result.changed_files,
        tool_trace_summary="\n".join(trace),
        diff="\n".join(patches),
        verification_summary="\n".join(verification),
        independently_verified=True,
    )


def public_memory(memory: MemoryRecord) -> dict[str, Any]:
    """给界面展示的字段；不含向量和内部校验值。"""
    return memory.model_dump(
        mode="json",
        include={
            "id",
            "kind",
            "memory_key",
            "title",
            "content",
            "applicability",
            "tags",
            "project_id",
            "source_run_ids",
            "created_at",
            "updated_at",
        },
    )
