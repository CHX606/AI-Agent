"""工作流引擎的公共数据模型。"""

from dataclasses import dataclass, field
from enum import StrEnum
from types import MappingProxyType
from typing import Any, Mapping


class StepStatus(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"


@dataclass(frozen=True, slots=True)
class Step:
    id: str
    action: str
    depends_on: tuple[str, ...] = ()
    payload: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Workflow:
    steps: tuple[Step, ...]


@dataclass(frozen=True, slots=True)
class StepResult:
    step_id: str
    status: StepStatus
    output: Any | None = None
    error: str | None = None


@dataclass(frozen=True, slots=True)
class WorkflowResult:
    results: tuple[StepResult, ...]
    layers: tuple[tuple[str, ...], ...]

    @property
    def succeeded(self) -> bool:
        return all(result.status is StepStatus.SUCCESS for result in self.results)

    @property
    def by_id(self) -> Mapping[str, StepResult]:
        return MappingProxyType({result.step_id: result for result in self.results})
