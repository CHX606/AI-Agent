"""在长期记忆提炼前压缩长任务证据。"""

import hashlib
from typing import Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field

from bit_agent.memory.budget import estimate_tokens, truncate_to_token_budget
from bit_agent.memory.models import CompactedRunEvidence, VerifiedRunEvidence


class EvidenceCompactionPolicy(BaseModel):
    """按字段保留证据，避免单一巨大 diff 吞掉全部上下文。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    objective_tokens: int = Field(default=800, gt=0)
    working_memory_tokens: int = Field(default=2_500, gt=0)
    final_answer_tokens: int = Field(default=1_200, gt=0)
    tool_trace_tokens: int = Field(default=2_500, gt=0)
    diff_tokens: int = Field(default=4_000, gt=0)
    verification_tokens: int = Field(default=1_000, gt=0)
    max_total_tokens: int = Field(default=14_000, gt=0)


@runtime_checkable
class EvidenceCompactor(Protocol):
    """把完整验证证据转换为可审计、受预算控制的输入。"""

    def compact(self, evidence: VerifiedRunEvidence) -> CompactedRunEvidence: ...


class DeterministicEvidenceCompactor:
    """不调用模型的首层压缩，保证超长任务也有稳定上限。"""

    def __init__(self, policy: EvidenceCompactionPolicy | None = None) -> None:
        self.policy = policy or EvidenceCompactionPolicy()

    def compact(self, evidence: VerifiedRunEvidence) -> CompactedRunEvidence:
        raw_json = evidence.model_dump_json()
        working_memory = evidence.working_memory.model_dump_json(indent=2)
        fields = {
            "objective": truncate_to_token_budget(
                evidence.objective,
                self.policy.objective_tokens,
            ),
            "working_memory_summary": truncate_to_token_budget(
                working_memory,
                self.policy.working_memory_tokens,
            ),
            "final_answer": truncate_to_token_budget(
                evidence.final_answer,
                self.policy.final_answer_tokens,
            ),
            "tool_trace_summary": truncate_to_token_budget(
                evidence.tool_trace_summary,
                self.policy.tool_trace_tokens,
            ),
            "diff_summary": truncate_to_token_budget(
                evidence.diff,
                self.policy.diff_tokens,
            ),
            "verification_summary": truncate_to_token_budget(
                evidence.verification_summary,
                self.policy.verification_tokens,
            ),
        }
        estimated = estimate_tokens("\n".join(fields.values()))
        while estimated > self.policy.max_total_tokens:
            largest_name = max(fields, key=lambda name: estimate_tokens(fields[name]))
            largest_tokens = estimate_tokens(fields[largest_name])
            if largest_tokens <= 1:
                break
            overflow = estimated - self.policy.max_total_tokens
            new_budget = max(1, largest_tokens - max(1, overflow))
            fields[largest_name] = truncate_to_token_budget(
                fields[largest_name],
                new_budget,
            )
            next_estimated = estimate_tokens("\n".join(fields.values()))
            if next_estimated >= estimated:
                fields[largest_name] = truncate_to_token_budget(
                    fields[largest_name],
                    max(1, largest_tokens // 2),
                    marker="",
                )
                next_estimated = estimate_tokens("\n".join(fields.values()))
            estimated = next_estimated

        return CompactedRunEvidence(
            run_id=evidence.run_id,
            thread_id=evidence.thread_id,
            project_id=evidence.project_id,
            user_id=evidence.user_id,
            objective=fields["objective"],
            working_memory_summary=fields["working_memory_summary"],
            final_answer=fields["final_answer"],
            changed_files=evidence.changed_files,
            tool_trace_summary=fields["tool_trace_summary"],
            diff_summary=fields["diff_summary"],
            verification_summary=fields["verification_summary"],
            independently_verified=evidence.independently_verified,
            original_characters=len(raw_json),
            compacted_characters=sum(len(value) for value in fields.values()),
            estimated_tokens=estimated,
            evidence_hash=hashlib.sha256(raw_json.encode("utf-8")).hexdigest(),
        )
