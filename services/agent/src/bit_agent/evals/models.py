"""Bit Agent 可重复评测的题目、违规项与最终结果。"""

from pathlib import Path, PurePosixPath

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from bit_agent.agent.result import AgentRunResult
from bit_agent.memory.models import MemoryConsolidationResult
from bit_agent.tools.models import ToolResult

DEFAULT_IGNORED_PATHS = [
    "**/__pycache__/**",
    "**/.pytest_cache/**",
    "**/.ruff_cache/**",
    "**/*.pyc",
]
DEFAULT_IMMUTABLE_PATHS = [
    ".git/**",
    ".env",
    ".env.*",
]


def _validate_relative_pattern(pattern: str) -> str:
    normalized = pattern.strip().replace("\\", "/")
    if not normalized:
        raise ValueError("路径规则不能为空")
    path = PurePosixPath(normalized)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("路径规则必须是工作区内的相对路径")
    return normalized


class EvalCase(BaseModel):
    """一项评测的固定输入和可信判分规则。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str = Field(min_length=1, pattern=r"^[a-z][a-z0-9_-]*$")
    prompt: str = Field(min_length=1)
    fixture_path: Path
    test_target: str = Field(min_length=1)
    allowed_paths: list[str] = Field(default_factory=list)
    immutable_paths: list[str] = Field(default_factory=lambda: list(DEFAULT_IMMUTABLE_PATHS))
    ignored_paths: list[str] = Field(default_factory=lambda: list(DEFAULT_IGNORED_PATHS))
    require_changes: bool = True
    require_agent_tests: bool = True
    verification_timeout_seconds: float = Field(default=30.0, gt=0, le=300.0)

    @field_validator("prompt", "test_target")
    @classmethod
    def strip_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("字段不能为空")
        return normalized

    @field_validator("test_target")
    @classmethod
    def validate_test_target(cls, value: str) -> str:
        return _validate_relative_pattern(value)

    @field_validator("allowed_paths", "immutable_paths", "ignored_paths")
    @classmethod
    def validate_path_patterns(cls, patterns: list[str]) -> list[str]:
        normalized = [_validate_relative_pattern(pattern) for pattern in patterns]
        if len(normalized) != len(set(normalized)):
            raise ValueError("路径规则不能重复")
        return normalized

    @field_validator("fixture_path")
    @classmethod
    def validate_fixture_path(cls, value: Path) -> Path:
        resolved = value.resolve()
        if not resolved.is_dir():
            raise ValueError("fixture_path 必须是已存在的目录")
        return resolved


class EvalViolation(BaseModel):
    """评测器发现的一项可机器处理的失败原因。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    path: str | None = None


class FileChanges(BaseModel):
    """通过评测前后快照计算出的真实文件变化。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    added: list[str] = Field(default_factory=list)
    modified: list[str] = Field(default_factory=list)
    deleted: list[str] = Field(default_factory=list)

    @property
    def all_paths(self) -> list[str]:
        return sorted({*self.added, *self.modified, *self.deleted})

    @model_validator(mode="after")
    def validate_paths(self) -> "FileChanges":
        for paths in (self.added, self.modified, self.deleted):
            if paths != sorted(set(paths)):
                raise ValueError("文件变化路径必须去重并稳定排序")
        if set(self.added) & set(self.modified):
            raise ValueError("新增文件不能同时标记为修改")
        if set(self.added) & set(self.deleted):
            raise ValueError("新增文件不能同时标记为删除")
        if set(self.modified) & set(self.deleted):
            raise ValueError("修改文件不能同时标记为删除")
        return self


class EvalResult(BaseModel):
    """评测器交给人、CI 或主 Agent 的完整判分结果。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    run_id: str = Field(min_length=1)
    case_name: str = Field(min_length=1)
    passed: bool
    agent_result: AgentRunResult
    verification_result: ToolResult
    file_changes: FileChanges
    violations: list[EvalViolation] = Field(default_factory=list)
    artifact_directory: Path
    memory_consolidation: MemoryConsolidationResult | None = None

    @model_validator(mode="after")
    def validate_passed(self) -> "EvalResult":
        if self.passed != (not self.violations):
            raise ValueError("passed 必须与 violations 是否为空一致")
        return self
