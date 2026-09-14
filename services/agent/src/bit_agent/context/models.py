"""运行时 Context Manager 的稳定数据模型与预算配置。"""

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ContextManagementPolicy(BaseModel):
    """控制何时压缩、保留多少近期历史以及单项输出上限。"""

    model_config = ConfigDict(extra="forbid", frozen=True) #禁止额外字段，且实例不可变

    context_window_tokens: int = Field(default=128_000, gt=1_024) #上下文窗口大小，单位为 Token，必须大于 1024
    reserved_output_tokens: int = Field(default=8_000, gt=0) #保留输出 Token 数，单位为 Token，必须大于 0
    target_ratio: float = Field(default=0.60, gt=0.0, lt=1.0) #目标输入比例，必须在 0.0 和 1.0 之间
    soft_limit_ratio: float = Field(default=0.75, gt=0.0, lt=1.0) #软限制输入比例，必须在 0.0 和 1.0 之间
    hard_limit_ratio: float = Field(default=0.90, gt=0.0, le=1.0) #硬限制输入比例，必须在 0.0 和 1.0 之间
    keep_recent_groups: int = Field(default=8, gt=0, le=100) #保留近期原子组数量，必须大于 0 且小于等于 100
    minimum_recent_groups: int = Field(default=2, gt=0, le=100) #最少保留近期原子组数量，必须大于 0 且小于等于 100
    tool_output_artifact_tokens: int = Field(default=4_000, gt=0) #工具输出触发 Artifact 的 Token 上限，单位为 Token，必须大于 0
    inline_tool_output_tokens: int = Field(default=1_200, gt=0) #内联工具输出的 Token 上限，单位为 Token，必须大于 0
    summarization_input_tokens: int = Field(default=24_000, ge=256) #摘要输入的 Token 上限，单位为 Token，必须大于等于 256
    summary_tokens: int = Field(default=4_000, ge=128) #摘要输出的 Token 上限，单位为 Token，必须大于等于 128

    @model_validator(mode="after")
    def validate_budget_order(self) -> "ContextManagementPolicy": #验证预算配置的顺序关系，确保 target < soft < hard，且其他约束条件满足。
        if not self.target_ratio < self.soft_limit_ratio < self.hard_limit_ratio:
            raise ValueError("Context 比例必须满足 target < soft < hard")
        if self.reserved_output_tokens >= self.context_window_tokens:
            raise ValueError("预留输出 Token 必须小于 Context Window")
        if self.minimum_recent_groups > self.keep_recent_groups:
            raise ValueError("minimum_recent_groups 不能大于 keep_recent_groups")
        if self.inline_tool_output_tokens >= self.tool_output_artifact_tokens:
            raise ValueError("内联工具结果上限必须小于 Artifact 触发上限")
        return self

    @property
    def available_input_tokens(self) -> int: #可用输入 Token 数量，等于上下文窗口大小减去预留输出 Token 数量。
        return self.context_window_tokens - self.reserved_output_tokens

    @property
    def target_tokens(self) -> int: #目标输入 Token 数量，等于可用输入 Token 数量乘以目标比例。
        return int(self.available_input_tokens * self.target_ratio)

    @property
    def soft_limit_tokens(self) -> int: #软限制输入 Token 数量，等于可用输入 Token 数量乘以软限制比例。
        return int(self.available_input_tokens * self.soft_limit_ratio)

    @property
    def hard_limit_tokens(self) -> int: #硬限制输入 Token 数量，等于可用输入 Token 数量乘以硬限制比例。
        return int(self.available_input_tokens * self.hard_limit_ratio)

    @classmethod
    def from_environment( #从环境变量读取配置
        cls,
        environment: Mapping[str, str] | None = None,
    ) -> "ContextManagementPolicy":
        """从 CONTEXT_* 环境变量读取配置，未提供的字段使用稳定默认值。"""
        if environment is None:
            load_dotenv()
            environment = os.environ
        defaults = cls()
        return cls(
            context_window_tokens=environment.get(
                "CONTEXT_WINDOW_TOKENS",
                str(defaults.context_window_tokens),
            ),
            reserved_output_tokens=environment.get(
                "CONTEXT_RESERVED_OUTPUT_TOKENS",
                str(defaults.reserved_output_tokens),
            ),
            target_ratio=environment.get("CONTEXT_TARGET_RATIO", str(defaults.target_ratio)),
            soft_limit_ratio=environment.get(
                "CONTEXT_SOFT_LIMIT_RATIO",
                str(defaults.soft_limit_ratio),
            ),
            hard_limit_ratio=environment.get(
                "CONTEXT_HARD_LIMIT_RATIO",
                str(defaults.hard_limit_ratio),
            ),
            keep_recent_groups=environment.get(
                "CONTEXT_RECENT_GROUPS",
                str(defaults.keep_recent_groups),
            ),
            minimum_recent_groups=environment.get(
                "CONTEXT_MINIMUM_RECENT_GROUPS",
                str(defaults.minimum_recent_groups),
            ),
            tool_output_artifact_tokens=environment.get(
                "CONTEXT_ARTIFACT_TRIGGER_TOKENS",
                str(defaults.tool_output_artifact_tokens),
            ),
            inline_tool_output_tokens=environment.get(
                "CONTEXT_INLINE_TOOL_OUTPUT_TOKENS",
                str(defaults.inline_tool_output_tokens),
            ),
            summarization_input_tokens=environment.get(
                "CONTEXT_SUMMARIZATION_INPUT_TOKENS",
                str(defaults.summarization_input_tokens),
            ),
            summary_tokens=environment.get(
                "CONTEXT_SUMMARY_TOKENS",
                str(defaults.summary_tokens),
            ),
        )


class ContextSummary(BaseModel):
    """旧历史经过压缩后保留下来的任务相关信息。"""

    model_config = ConfigDict(extra="forbid", frozen=True) #禁止额外字段，且实例不可变

    objective: str = Field(min_length=1, max_length=4_000) #任务目标，不能为空，最大长度为 4000
    constraints: list[str] = Field(default_factory=list, max_length=50) #任务约束条件，最大长度为 50
    confirmed_facts: list[str] = Field(default_factory=list, max_length=100) #已确认的事实，最大长度为 100
    files_examined: list[str] = Field(default_factory=list, max_length=200) #已检查的文件，最大长度为 200
    changes_made: list[str] = Field(default_factory=list, max_length=200) #已做的更改，最大长度为 200
    failed_attempts: list[str] = Field(default_factory=list, max_length=100) #失败的尝试，最大长度为 100
    unresolved_errors: list[str] = Field(default_factory=list, max_length=100) #未解决的错误，最大长度为 100
    next_actions: list[str] = Field(default_factory=list, max_length=50) #下一步行动，最大长度为 50

    @field_validator("objective") #验证任务目标，去除首尾空白字符，不能为空
    @classmethod
    def strip_objective(cls, value: str) -> str: #去除首尾空白字符
        normalized = value.strip()
        if not normalized:
            raise ValueError("ContextSummary objective 不能为空")
        return normalized

    @field_validator(
        "constraints",
        "confirmed_facts",
        "files_examined",
        "changes_made",
        "failed_attempts",
        "unresolved_errors",
        "next_actions",
    )
    @classmethod
    def normalize_list(cls, values: list[str]) -> list[str]: #去除首尾空白字符，过滤掉空字符串，并去重
        normalized: list[str] = []
        for value in values:
            item = value.strip()
            if item and item not in normalized:
                normalized.append(item)
        return normalized


class ContextArtifact(BaseModel):
    """从 Prompt 外置的大型工具结果的可审计引用。"""

    model_config = ConfigDict(extra="forbid", frozen=True) #禁止额外字段，且实例不可变

    tool_call_id: str = Field(min_length=1) #工具调用 ID，不能为空
    path: str = Field(min_length=1) #工具结果文件路径，不能为空
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$") #工具结果文件的 SHA256 校验和，必须是 64 位十六进制字符串
    original_tokens: int = Field(gt=0) #工具结果的原始 Token 数量，必须大于 0
    original_characters: int = Field(gt=0) #工具结果的原始字符数，必须大于 0


@dataclass(frozen=True)
class ContextPreparation:
    """一次模型调用前准备好的输入和压缩信息。"""

    items: list[Any] #原始历史消息列表，包含用户输入、模型输出、工具调用等
    estimated_tokens: int #估计的总 Token 数量
    compacted: bool #是否经过压缩
    summary: ContextSummary | None #压缩后的摘要信息，如果没有压缩则为 None
