"""独立验证通过后的长期记忆巩固流水线。"""

import hashlib
import re
from dataclasses import dataclass
from datetime import UTC, datetime

from bit_agent.memory.chunking import MemoryChunker, MemoryChunkingPolicy
from bit_agent.memory.embedding import EmbeddingProvider, resolve_embedding_profile
from bit_agent.memory.extractor import MemoryCandidateExtractor
from bit_agent.memory.models import (
    ConsolidationStatus,
    MemoryCandidate,
    MemoryConsolidationResult,
    MemoryDisposition,
    MemoryRecord,
    MemoryReview,
    MemoryScope,
    MemorySourceReference,
    VerifiedRunEvidence,
)
from bit_agent.memory.policy import MemoryWritePolicy
from bit_agent.memory.store import LongTermMemoryStore


@dataclass(frozen=True)
class _PendingMemory:
    candidate: MemoryCandidate
    root_id: str
    records: list[MemoryRecord]


class MemoryConsolidator:
    """让 LLM 提炼候选，但把最终写入权留在 Harness。"""

    def __init__(
        self,
        extractor: MemoryCandidateExtractor,
        store: LongTermMemoryStore,
        *,
        embedding_provider: EmbeddingProvider | None = None,
        policy: MemoryWritePolicy | None = None,
        chunking_policy: MemoryChunkingPolicy | None = None,
        embedding_batch_size: int = 64,
    ) -> None:
        if embedding_batch_size <= 0:
            raise ValueError("embedding_batch_size 必须大于 0")
        self.extractor = extractor
        self.store = store
        self.embedding_provider = embedding_provider
        self.policy = policy or MemoryWritePolicy()
        self.chunker = MemoryChunker(chunking_policy)
        self.embedding_batch_size = embedding_batch_size

    async def consolidate(self, evidence: VerifiedRunEvidence) -> MemoryConsolidationResult:
        if not evidence.independently_verified:
            return MemoryConsolidationResult(
                run_id=evidence.run_id,
                status=ConsolidationStatus.SKIPPED,
            )

        try:
            candidates = await self.extractor.extract(evidence)
            reviews: list[MemoryReview] = []
            created: list[MemoryRecord] = []
            updated: list[MemoryRecord] = []
            pending: list[_PendingMemory] = []
            evidence_hash = hashlib.sha256(
                evidence.model_dump_json().encode("utf-8")
            ).hexdigest()
            source_reference = MemorySourceReference(
                run_id=evidence.run_id,
                evidence_hash=evidence_hash,
                artifact_uri=evidence.source_artifact_uri,
            )

            for candidate in candidates:
                reasons = self.policy.rejection_reasons(
                    candidate,
                    independently_verified=evidence.independently_verified,
                    project_id=evidence.project_id,
                    user_id=evidence.user_id,
                )
                if reasons:
                    reviews.append(
                        MemoryReview(
                            candidate=candidate,
                            disposition=MemoryDisposition.REJECTED,
                            reasons=reasons,
                        )
                    )
                    continue

                existing = await self.store.find_by_key(
                    scope=candidate.scope,
                    memory_key=candidate.memory_key,
                    project_id=(
                        evidence.project_id
                        if candidate.scope is MemoryScope.PROJECT
                        else None
                    ),
                    user_id=(
                        evidence.user_id if candidate.scope is MemoryScope.USER else None
                    ),
                )
                if existing is not None:
                    if _normalize_content(existing.content) != _normalize_content(
                        candidate.content
                    ):
                        reviews.append(
                            MemoryReview(
                                candidate=candidate,
                                disposition=MemoryDisposition.CONFLICT,
                                reasons=["相同 memory_key 已存在不同内容，需要进一步验证"],
                                memory_id=existing.id,
                            )
                        )
                        continue

                    merged = _merge_memory(
                        existing,
                        candidate,
                        evidence.run_id,
                        source_reference,
                    )
                    await self.store.save(merged)
                    updated.append(merged)
                    reviews.append(
                        MemoryReview(
                            candidate=candidate,
                            disposition=MemoryDisposition.MERGED,
                            reasons=["与已有已验证记忆内容一致，合并证据来源"],
                            memory_id=merged.id,
                        )
                    )
                    continue

                root, records = self.chunker.build_records(
                    candidate,
                    source_run_id=evidence.run_id,
                    project_id=evidence.project_id,
                    user_id=evidence.user_id,
                    source_reference=source_reference,
                )
                pending.append(
                    _PendingMemory(
                        candidate=candidate,
                        root_id=root.id,
                        records=records,
                    )
                )

            if pending:
                pending = await self._attach_embeddings(pending)
                records_to_save = [record for item in pending for record in item.records]
                await self.store.save_many(records_to_save)
                created.extend(records_to_save)
                for item in pending:
                    reviews.append(
                        MemoryReview(
                            candidate=item.candidate,
                            disposition=MemoryDisposition.ACCEPTED,
                            memory_id=item.root_id,
                        )
                    )

            return MemoryConsolidationResult(
                run_id=evidence.run_id,
                status=ConsolidationStatus.COMPLETED,
                reviews=reviews,
                created=created,
                updated=updated,
            )
        except Exception as exc:
            return MemoryConsolidationResult(
                run_id=evidence.run_id,
                status=ConsolidationStatus.FAILED,
                error=f"{type(exc).__name__}: {exc}",
            )

    async def _attach_embeddings(
        self,
        pending: list[_PendingMemory],
    ) -> list[_PendingMemory]:
        if self.embedding_provider is None:
            return pending

        targets: list[tuple[int, int]] = []
        texts: list[str] = []
        for pending_index, item in enumerate(pending):
            for record_index, record in enumerate(item.records):
                is_long_root = record.parent_memory_id is None and record.chunk_count > 1
                if is_long_root:
                    continue
                targets.append((pending_index, record_index))
                texts.append(record.embedding_text)

        vectors: list[list[float]] = []
        for offset in range(0, len(texts), self.embedding_batch_size):
            batch = texts[offset : offset + self.embedding_batch_size]
            batch_vectors = await self.embedding_provider.embed(batch)
            if len(batch_vectors) != len(batch) or any(not vector for vector in batch_vectors):
                raise ValueError("EmbeddingProvider 返回的向量数量或内容无效")
            vectors.extend(batch_vectors)
        if not vectors:
            return pending
        dimensions = len(vectors[0])
        if any(len(vector) != dimensions for vector in vectors):
            raise ValueError("EmbeddingProvider 在同一批次返回了不同维度")
        profile = resolve_embedding_profile(self.embedding_provider, vectors[0])

        mutable_records = [list(item.records) for item in pending]
        for (pending_index, record_index), vector in zip(targets, vectors, strict=True):
            record = mutable_records[pending_index][record_index]
            mutable_records[pending_index][record_index] = _validated_copy(
                record,
                embedding=vector,
                embedding_profile=profile,
            )
        return [
            _PendingMemory(
                candidate=item.candidate,
                root_id=item.root_id,
                records=mutable_records[index],
            )
            for index, item in enumerate(pending)
        ]


def _normalize_content(content: str) -> str:
    return re.sub(r"\s+", " ", content).strip().casefold()


def _merge_memory(
    existing: MemoryRecord,
    candidate: MemoryCandidate,
    source_run_id: str,
    source_reference: MemorySourceReference,
) -> MemoryRecord:
    source_run_ids = list(existing.source_run_ids)
    if source_run_id not in source_run_ids:
        source_run_ids.append(source_run_id)
    source_references = list(existing.source_references)
    if source_reference not in source_references:
        source_references.append(source_reference)
    evidence_parts = [existing.evidence_summary]
    if candidate.evidence_summary not in evidence_parts:
        evidence_parts.append(candidate.evidence_summary)
    evidence_summary = "\n".join(evidence_parts)
    if len(evidence_summary) > 4_000:
        evidence_summary = evidence_summary[-4_000:]
    return _validated_copy(
        existing,
        evidence_summary=evidence_summary,
        tags=sorted({*existing.tags, *candidate.tags}),
        importance=max(existing.importance, candidate.importance),
        confidence=max(existing.confidence, candidate.confidence),
        source_run_ids=source_run_ids,
        source_references=source_references,
        updated_at=datetime.now(UTC),
    )


def _validated_copy(memory: MemoryRecord, **updates: object) -> MemoryRecord:
    payload = memory.model_dump(mode="python")
    payload.update(updates)
    return MemoryRecord.model_validate(payload)
