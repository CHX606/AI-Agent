"""依赖感知的同步/异步 Action 调度器。"""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from workflow_engine.models import Step, Workflow, WorkflowResult

Action = Callable[[Step, Mapping[str, Any]], Any | Awaitable[Any]]


class WorkflowRunner:
    def __init__(
        self,
        actions: Mapping[str, Action],
        *,
        max_concurrency: int = 4,
        fail_fast: bool = False,
    ) -> None:
        raise NotImplementedError

    async def run(self, workflow: Workflow) -> WorkflowResult:
        raise NotImplementedError
