"""所有工具共享的结构化返回模型。"""

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ToolStatus(StrEnum):
    """一次工具调用的最终状态。"""

    SUCCESS = "SUCCESS"
    ERROR = "ERROR"
    REJECTED = "REJECTED"
    TIMEOUT = "TIMEOUT"


class ToolError(BaseModel):
    """机器可读且适合展示给模型的工具错误。"""

    model_config = ConfigDict(frozen=True)

    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    retryable: bool


class ToolMetadata(BaseModel):
    """与具体输出无关的工具执行信息。"""

    model_config = ConfigDict(frozen=True)

    duration_ms: int = Field(ge=0)
    truncated: bool = False
    affected_paths: list[str] = Field(default_factory=list)


class ToolResult(BaseModel):
    """工具成功、失败、拒绝和超时共用的返回信封。"""

    model_config = ConfigDict(frozen=True)

    tool_call_id: str = Field(min_length=1)
    tool_name: str = Field(min_length=1)
    status: ToolStatus
    output: Any | None = None
    error: ToolError | None = None
    metadata: ToolMetadata

    @model_validator(mode="after")
    def validate_status_payload(self) -> "ToolResult":
        if self.status is ToolStatus.SUCCESS and self.error is not None:
            raise ValueError("成功结果不能包含错误")
        if self.status is not ToolStatus.SUCCESS and self.error is None:
            raise ValueError("非成功结果必须包含错误")
        return self
