"""动态 Agent 的工具轨迹与整次运行结果。"""

import json
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from bit_agent.memory.models import WorkingMemory
from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus


class AgentRunStatus(StrEnum):
    """一次 Agent 任务的最终状态。"""

    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class ToolCallRecord(BaseModel):
    """模型申请并由 Python 执行的一次工具调用记录。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    round: int = Field(gt=0)
    tool_call_id: str = Field(min_length=1)
    tool_name: str = Field(min_length=1)
    raw_arguments: str
    arguments: dict[str, JsonValue] | None = None
    status: ToolStatus
    output: Any | None = None
    error: ToolError | None = None
    metadata: ToolMetadata

    @property
    def succeeded(self) -> bool:
        """本次工具调用是否成功。"""
        return self.status is ToolStatus.SUCCESS

    @classmethod
    def from_tool_result(
        cls,
        *,
        round_number: int,
        raw_arguments: str,
        result: ToolResult,
    ) -> "ToolCallRecord":
        """把 Python 工具结果对象转换为稳定的轨迹记录。"""
        try:
            parsed_arguments = json.loads(raw_arguments)
        except (json.JSONDecodeError, TypeError):
            parsed_arguments = None
        if not isinstance(parsed_arguments, dict):
            parsed_arguments = None

        return cls(
            round=round_number,
            tool_call_id=result.tool_call_id,
            tool_name=result.tool_name,
            raw_arguments=raw_arguments,
            arguments=parsed_arguments,
            status=result.status,
            output=result.output,
            error=result.error,
            metadata=result.metadata,
        )


class AgentRunResult(BaseModel):
    """一次动态 Agent 任务结束后交给调用方的结构化回执。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    thread_id: str | None = None
    run_id: str | None = None
    status: AgentRunStatus
    final_answer: str | None = None
    rounds: int = Field(ge=0)
    tool_calls: list[ToolCallRecord] = Field(default_factory=list)
    changed_files: list[str] = Field(default_factory=list)
    tests_passed: bool = False
    quality_checks_passed: bool = False
    acceptance_status: Literal["NOT_RUN", "PASSED", "FAILED", "NOT_VERIFIED"] = "NOT_RUN"
    error: str | None = None
    working_memory: WorkingMemory | None = None
    memory_warnings: list[str] = Field(default_factory=list)
    recalled_memory_ids: list[str] = Field(default_factory=list)
    memory_context_tokens: int = Field(default=0, ge=0)
    context_compactions: int = Field(default=0, ge=0)
    context_peak_input_tokens: int = Field(default=0, ge=0)
    context_last_input_tokens: int = Field(default=0, ge=0)
    context_artifact_paths: list[str] = Field(default_factory=list)
    context_warnings: list[str] = Field(default_factory=list)
    event_trace_id: str | None = None
    event_count: int = Field(default=0, ge=0)
    event_artifact_paths: list[str] = Field(default_factory=list)
    event_warnings: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_terminal_payload(self) -> "AgentRunResult":
        if self.status is AgentRunStatus.COMPLETED:
            if self.final_answer is None:
                raise ValueError("完成的 Agent 运行必须包含 final_answer")
            if self.error is not None:
                raise ValueError("完成的 Agent 运行不能包含 error")
        elif self.error is None:
            raise ValueError("失败的 Agent 运行必须包含 error")

        if self.changed_files != sorted(set(self.changed_files)):
            raise ValueError("changed_files 必须去重并稳定排序")
        if self.context_artifact_paths != sorted(set(self.context_artifact_paths)):
            raise ValueError("context_artifact_paths 必须去重并稳定排序")
        if self.event_artifact_paths != sorted(set(self.event_artifact_paths)):
            raise ValueError("event_artifact_paths 必须去重并稳定排序")
        if (self.thread_id is None) != (self.run_id is None):
            raise ValueError("thread_id 和 run_id 必须同时提供或同时省略")
        return self
