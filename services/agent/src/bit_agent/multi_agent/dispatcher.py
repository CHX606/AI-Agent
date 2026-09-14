"""按依赖图并发运行上下文和工作区都隔离的子 Agent。"""

import asyncio
import json
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Any
from uuid import uuid4

from bit_agent.agent import AgentRunResult, AgentRunStatus, run_agent
from bit_agent.agent.runtime import execute_tool
from bit_agent.multi_agent.models import (
    SubAgentResult,
    SubAgentStatus,
    TaskPlan,
    TaskSpec,
)
from bit_agent.multi_agent.workspace import IsolatedWorkspaceManager
from bit_agent.observability import EventBus
from bit_agent.tool_provider import LocalToolProvider, RestrictedToolProvider

SubAgentRunner = Callable[..., Awaitable[AgentRunResult]]

READ_ONLY_TOOLS = {"list_files", "read_file", "search_code", "run_checks", "run_tests"}
RESERVED_AGENT_OPTIONS = {
    "prompt",
    "workspace_root",
    "response_client",
    "model_name",
    "tool_provider",
    "thread_id",
    "max_tool_rounds",
    "working_memory_objective",
    "event_bus",
    "event_sink",
    "agent_id",
    "task_id",
}


class TaskDispatcher:
    """并发执行已就绪任务；依赖失败时确定性阻塞下游任务。"""

    def __init__(
        self,
        *,
        agent_runner: SubAgentRunner = run_agent,
        workspace_manager: IsolatedWorkspaceManager | None = None,
        max_concurrency: int = 3,
    ) -> None:
        if max_concurrency <= 0:
            raise ValueError("max_concurrency 必须大于 0")
        self.agent_runner = agent_runner
        self.workspace_manager = workspace_manager or IsolatedWorkspaceManager()
        self.max_concurrency = max_concurrency

    async def dispatch(
        self,
        plan: TaskPlan,
        *,
        workspace_root: Path,
        response_client: Any,
        model_name: str,
        agent_options: Mapping[str, Any] | None = None,
        event_bus: EventBus | None = None,
    ) -> list[SubAgentResult]:
        options = dict(agent_options or {})
        reserved = RESERVED_AGENT_OPTIONS & options.keys()
        if reserved:
            raise ValueError(f"子 Agent 选项不能覆盖框架字段：{sorted(reserved)}")

        results: dict[str, SubAgentResult] = {}
        finished = {task.id: asyncio.Event() for task in plan.tasks}
        semaphore = asyncio.Semaphore(self.max_concurrency)

        async def execute(task: TaskSpec) -> None:
            try:
                if task.depends_on:
                    await asyncio.gather(*(finished[item].wait() for item in task.depends_on))
                failed_dependencies = [
                    item
                    for item in task.depends_on
                    if results[item].status is not SubAgentStatus.COMPLETED
                ]
                if failed_dependencies:
                    results[task.id] = SubAgentResult(
                        task_id=task.id,
                        role=task.role,
                        status=SubAgentStatus.BLOCKED,
                        error=f"依赖任务未完成：{failed_dependencies}",
                    )
                    return

                dependency_results = [results[item] for item in task.depends_on]
                async with semaphore:
                    results[task.id] = await self._run_task(
                        task,
                        overall_objective=plan.objective,
                        dependency_results=dependency_results,
                        workspace_root=workspace_root,
                        response_client=response_client,
                        model_name=model_name,
                        agent_options=options,
                        event_bus=event_bus,
                    )
            except Exception as exc:
                results[task.id] = SubAgentResult(
                    task_id=task.id,
                    role=task.role,
                    status=SubAgentStatus.FAILED,
                    error=f"{type(exc).__name__}: {exc}",
                )
            finally:
                finished[task.id].set()

        await asyncio.gather(*(execute(task) for task in plan.tasks))
        return [results[task.id] for task in plan.tasks]

    async def _run_task(
        self,
        task: TaskSpec,
        *,
        overall_objective: str,
        dependency_results: list[SubAgentResult],
        workspace_root: Path,
        response_client: Any,
        model_name: str,
        agent_options: Mapping[str, Any],
        event_bus: EventBus | None,
    ) -> SubAgentResult:
        prompt = _build_subagent_prompt(task, overall_objective, dependency_results)
        async with self.workspace_manager.create(workspace_root, task.id) as isolated_workspace:
            provider = RestrictedToolProvider(
                LocalToolProvider(isolated_workspace, execute_tool),
                READ_ONLY_TOOLS,
            )
            result = await self.agent_runner(
                prompt,
                workspace_root=isolated_workspace,
                response_client=response_client,
                model_name=model_name,
                tool_provider=provider,
                thread_id=f"subagent-{task.id}-{uuid4().hex}",
                working_memory_objective=task.objective,
                max_tool_rounds=task.max_tool_rounds,
                event_bus=event_bus,
                agent_id=f"subagent:{task.id}",
                task_id=task.id,
                **agent_options,
            )

        evidence_files = []
        if result.working_memory is not None:
            evidence_files = sorted(set(result.working_memory.files_read))
        if result.changed_files:
            return SubAgentResult(
                task_id=task.id,
                role=task.role,
                status=SubAgentStatus.FAILED,
                evidence_files=evidence_files,
                agent_result=result,
                error="只读子 Agent 报告了文件修改，结果已拒绝",
            )
        if result.status is AgentRunStatus.FAILED:
            return SubAgentResult(
                task_id=task.id,
                role=task.role,
                status=SubAgentStatus.FAILED,
                evidence_files=evidence_files,
                agent_result=result,
                error=result.error or "子 Agent 运行失败",
            )
        return SubAgentResult(
            task_id=task.id,
            role=task.role,
            status=SubAgentStatus.COMPLETED,
            final_answer=result.final_answer,
            evidence_files=evidence_files,
            agent_result=result,
        )


def _build_subagent_prompt(
    task: TaskSpec,
    overall_objective: str,
    dependency_results: list[SubAgentResult],
) -> str:
    dependencies = [
        {
            "task_id": result.task_id,
            "role": result.role,
            "answer": (result.final_answer or "")[:8_000],
            "evidence_files": result.evidence_files,
        }
        for result in dependency_results
    ]
    focus_paths = task.focus_paths or ["未指定，由你通过浅层目录查看和搜索定位"]
    return (
        "[Multi-Agent 子任务]\n"
        f"总任务：{overall_objective}\n"
        f"你的角色：{task.role}\n"
        f"唯一目标：{task.objective}\n"
        f"补充要求：{task.instructions or '收集可验证证据'}\n"
        f"范围提示：{json.dumps(focus_paths, ensure_ascii=False)}\n"
        f"依赖结果：{json.dumps(dependencies, ensure_ascii=False)}\n\n"
        "你处于隔离的只读工作区，只能调查，不能修改代码。请使用工具核实，不要猜测。"
        "最终回答应包含结论、文件/符号/行号证据、风险和给主 Agent 的建议。"
    )
