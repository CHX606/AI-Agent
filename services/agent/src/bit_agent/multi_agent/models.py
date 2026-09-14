"""Multi-Agent 调度、执行和聚合使用的稳定数据模型。"""

from enum import StrEnum
from pathlib import PurePosixPath

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from bit_agent.agent import AgentRunResult, AgentRunStatus


class PlanSource(StrEnum):
    LLM = "LLM"
    RULE = "RULE"
    FALLBACK = "FALLBACK"


class TaskRoute(StrEnum):
    """用户输入进入直接回复还是仓库执行链路。"""

    DIRECT = "direct"
    REPOSITORY = "repo"


class SubAgentStatus(StrEnum):
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    BLOCKED = "BLOCKED"


class MultiAgentRunStatus(StrEnum):
    COMPLETED = "COMPLETED"
    PARTIAL = "PARTIAL"
    FAILED = "FAILED"


def _normalize_text(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError("字段不能为空")
    return normalized


def _normalize_relative_hint(value: str) -> str:
    normalized = value.strip().replace("\\", "/")
    if not normalized:
        raise ValueError("路径提示不能为空")
    path = PurePosixPath(normalized)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("路径提示必须位于工作区内")
    return normalized


class TaskSpec(BaseModel):
    """分配给一个只读子 Agent 的独立调查任务。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-z][a-z0-9_-]*$")
    role: str = Field(min_length=1, max_length=100)
    objective: str = Field(min_length=1, max_length=2_000)
    instructions: str = Field(default="", max_length=4_000)
    focus_paths: list[str] = Field(default_factory=list, max_length=20)
    depends_on: list[str] = Field(default_factory=list, max_length=20)
    max_tool_rounds: int = Field(default=8, ge=1, le=20)

    @field_validator("id", "role", "objective")
    @classmethod
    def strip_required_text(cls, value: str) -> str:
        return _normalize_text(value)

    @field_validator("instructions")
    @classmethod
    def strip_optional_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("focus_paths")
    @classmethod
    def normalize_focus_paths(cls, values: list[str]) -> list[str]:
        normalized = [_normalize_relative_hint(value) for value in values]
        if len(normalized) != len(set(normalized)):
            raise ValueError("focus_paths 不能重复")
        return normalized

    @field_validator("depends_on")
    @classmethod
    def normalize_dependencies(cls, values: list[str]) -> list[str]:
        normalized = [_normalize_text(value) for value in values]
        if len(normalized) != len(set(normalized)):
            raise ValueError("depends_on 不能重复")
        return normalized


class TaskPlan(BaseModel):
    """一次运行的路由决定及可选 Multi-Agent 任务图。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    objective: str = Field(min_length=1, max_length=4_000)
    route: TaskRoute = TaskRoute.REPOSITORY
    tasks: list[TaskSpec] = Field(default_factory=list, max_length=8)

    @field_validator("objective")
    @classmethod
    def strip_objective(cls, value: str) -> str:
        return _normalize_text(value)

    @model_validator(mode="after")
    def validate_task_graph(self) -> "TaskPlan":
        if self.route is TaskRoute.DIRECT and self.tasks:
            raise ValueError("直接回复计划不能包含子任务")
        if self.route is TaskRoute.REPOSITORY and not self.tasks:
            raise ValueError("仓库任务计划至少需要一个子任务")

        task_ids = [task.id for task in self.tasks]
        if len(task_ids) != len(set(task_ids)):
            raise ValueError("TaskPlan 的任务 id 不能重复")

        known_ids = set(task_ids)
        dependencies = {task.id: set(task.depends_on) for task in self.tasks}
        for task in self.tasks:
            unknown = set(task.depends_on) - known_ids
            if unknown:
                raise ValueError(f"任务 {task.id} 引用了未知依赖：{sorted(unknown)}")
            if task.id in task.depends_on:
                raise ValueError(f"任务 {task.id} 不能依赖自身")

        remaining = {task_id: set(values) for task_id, values in dependencies.items()}
        while remaining:
            ready = {task_id for task_id, values in remaining.items() if not values}
            if not ready:
                raise ValueError("TaskPlan 不能包含循环依赖")
            remaining = {
                task_id: values - ready
                for task_id, values in remaining.items()
                if task_id not in ready
            }
        return self


class TaskPlanningResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    source: PlanSource
    plan: TaskPlan
    warnings: list[str] = Field(default_factory=list)


class SubAgentResult(BaseModel):
    """一个子 Agent 的结构化调查回执。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    task_id: str = Field(min_length=1)
    role: str = Field(min_length=1)
    status: SubAgentStatus
    final_answer: str | None = None
    evidence_files: list[str] = Field(default_factory=list)
    agent_result: AgentRunResult | None = None
    error: str | None = None

    @model_validator(mode="after")
    def validate_terminal_payload(self) -> "SubAgentResult":
        if self.status is SubAgentStatus.COMPLETED:
            if self.agent_result is None or self.final_answer is None:
                raise ValueError("完成的子 Agent 必须包含运行结果和回答")
            if self.agent_result.status is not AgentRunStatus.COMPLETED:
                raise ValueError("完成的子 Agent 不能包含失败的 AgentRunResult")
            if self.error is not None:
                raise ValueError("完成的子 Agent 不能包含 error")
        elif self.error is None:
            raise ValueError("失败或阻塞的子 Agent 必须包含 error")
        if self.evidence_files != sorted(set(self.evidence_files)):
            raise ValueError("evidence_files 必须去重并稳定排序")
        return self


class AggregationConflict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    task_ids: list[str] = Field(min_length=2)
    paths: list[str] = Field(default_factory=list)


class AggregationResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    main_agent_prompt: str = Field(min_length=1)
    completed_task_ids: list[str] = Field(default_factory=list)
    failed_task_ids: list[str] = Field(default_factory=list)
    conflicts: list[AggregationConflict] = Field(default_factory=list)
    truncated: bool = False


class MultiAgentRunResult(BaseModel):
    """Multi-Agent 从规划到主 Agent 完成任务的统一回执。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    run_id: str = Field(min_length=1)
    status: MultiAgentRunStatus
    objective: str = Field(min_length=1)
    planning: TaskPlanningResult
    subagents: list[SubAgentResult]
    aggregation: AggregationResult | None = None
    final_agent_result: AgentRunResult | None = None
    final_answer: str | None = None
    changed_files: list[str] = Field(default_factory=list)
    tests_passed: bool = False
    quality_checks_passed: bool = False
    error: str | None = None
    warnings: list[str] = Field(default_factory=list)
    event_count: int = Field(default=0, ge=0)
    event_artifact_paths: list[str] = Field(default_factory=list)
    event_warnings: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_terminal_payload(self) -> "MultiAgentRunResult":
        if self.status in {MultiAgentRunStatus.COMPLETED, MultiAgentRunStatus.PARTIAL}:
            if self.final_agent_result is None or self.final_answer is None:
                raise ValueError("完成或部分完成的运行必须包含主 Agent 结果")
            if self.final_agent_result.status is not AgentRunStatus.COMPLETED:
                raise ValueError("完成或部分完成的运行不能包含失败的主 Agent")
            if self.error is not None:
                raise ValueError("完成或部分完成的运行不能包含 error")
        elif self.error is None:
            raise ValueError("失败的 Multi-Agent 运行必须包含 error")
        if self.changed_files != sorted(set(self.changed_files)):
            raise ValueError("changed_files 必须去重并稳定排序")
        if self.event_artifact_paths != sorted(set(self.event_artifact_paths)):
            raise ValueError("event_artifact_paths 必须去重并稳定排序")
        return self
