"""长期记忆候选的确定性写入规则。"""

import re

from pydantic import BaseModel, ConfigDict, Field

from bit_agent.memory.models import MemoryCandidate, MemoryKind, MemoryScope

_SECRET_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(
        r"(?i)\b(?:api[_-]?key|access[_-]?token|password|secret)\b\s*[:=]\s*['\"]?\S{8,}"
    ),
)


class MemoryWritePolicy(BaseModel):
    """在 LLM 和数据库之间执行可信度、范围和安全检查。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    minimum_confidence: float = Field(default=0.75, ge=0.0, le=1.0)
    minimum_importance: float = Field(default=0.30, ge=0.0, le=1.0)
    minimum_content_length: int = Field(default=20, gt=0)
    allow_user_scope: bool = False
    allow_global_scope: bool = False

    def rejection_reasons(
        self,
        candidate: MemoryCandidate,
        *,
        independently_verified: bool,
        project_id: str | None,
        user_id: str | None,
    ) -> list[str]:
        reasons: list[str] = []
        if not independently_verified:
            reasons.append("任务没有通过独立验证")
        if candidate.confidence < self.minimum_confidence:
            reasons.append("候选可信度低于写入阈值")
        if candidate.importance < self.minimum_importance:
            reasons.append("候选重要性低于写入阈值")
        if len(candidate.content) < self.minimum_content_length:
            reasons.append("候选内容过短，缺少可复用信息")
        if candidate.scope is MemoryScope.PROJECT and not project_id:
            reasons.append("PROJECT 候选缺少 project_id")
        if candidate.scope is MemoryScope.USER:
            if not self.allow_user_scope:
                reasons.append("自动巩固默认禁止写入 USER Memory")
            if not user_id:
                reasons.append("USER 候选缺少 user_id")
        if candidate.scope is MemoryScope.GLOBAL and not self.allow_global_scope:
            reasons.append("自动巩固默认禁止写入 GLOBAL Memory")
        if candidate.kind is MemoryKind.PREFERENCE and not self.allow_user_scope:
            reasons.append("用户偏好必须来自显式用户记忆流程")
        candidate_text = "\n".join(
            (candidate.title, candidate.content, candidate.evidence_summary)
        )
        if any(pattern.search(candidate_text) for pattern in _SECRET_PATTERNS):
            reasons.append("候选疑似包含凭据或敏感信息")
        return reasons
