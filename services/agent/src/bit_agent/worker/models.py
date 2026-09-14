"""Gateway 与 Python Worker 共用的任务队列协议。"""

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator

from bit_agent.agent.limits import DEFAULT_MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS_LIMIT


class TaskStatus(StrEnum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    CANCELLATION_REQUESTED = "CANCELLATION_REQUESTED"
    CANCELLED = "CANCELLED"
    COMPLETED = "COMPLETED"
    PARTIAL = "PARTIAL"
    FAILED = "FAILED"


TERMINAL_TASK_STATUSES = {
    TaskStatus.CANCELLED,
    TaskStatus.COMPLETED,
    TaskStatus.PARTIAL,
    TaskStatus.FAILED,
}


class QueuedTask(BaseModel):
    """Gateway 写入 Redis 队列的最小任务载荷。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    task_id: str = Field(min_length=1, max_length=100)
    objective: str = Field(min_length=1, max_length=4_000)
    workspace_root: str = Field(min_length=1, max_length=4_096)
    created_at: datetime
    max_tool_rounds: int = Field(
        default=DEFAULT_MAX_TOOL_ROUNDS, ge=1, le=MAX_TOOL_ROUNDS_LIMIT, strict=True
    )

    @field_validator("task_id", "objective", "workspace_root")
    @classmethod
    def strip_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("字段不能为空")
        return normalized
