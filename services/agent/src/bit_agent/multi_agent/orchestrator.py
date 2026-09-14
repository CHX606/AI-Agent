"""Multi-Agent 从规划、并发调查到主 Agent 执行的总入口。"""

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Any
from uuid import uuid4

from bit_agent.agent import AgentRunResult, AgentRunStatus, run_agent
from bit_agent.multi_agent.aggregator import ResultAggregator
from bit_agent.multi_agent.dispatcher import TaskDispatcher
from bit_agent.multi_agent.models import (
    MultiAgentRunResult,
    MultiAgentRunStatus,
    PlanSource,
    SubAgentStatus,
    TaskPlanningResult,
    TaskRoute,
)
from bit_agent.multi_agent.planner import LLMTaskPlanner, TaskPlanner, build_fallback_plan
from bit_agent.observability import AgentEventType, EventBus, EventSink, JsonlEventSink

MainAgentRunner = Callable[..., Awaitable[AgentRunResult]]

DIRECT_RESPONSE_INSTRUCTIONS = """
你是 Bit Agent。当前输入不需要访问代码仓库，请直接用用户使用的语言自然、简洁地回答。
不要声称已经读取文件、调用工具、运行测试或修改代码。如果用户只是寒暄，就正常回应；
如果用户询问能力，可以说明你能在选定工作区内分析、修改并验证代码。
""".strip()

RESERVED_MAIN_OPTIONS = {
    "prompt",
    "workspace_root",
    "response_client",
    "model_name",
    "working_memory_objective",
    "event_bus",
    "event_sink",
    "agent_id",
    "task_id",
}


class MultiAgentOrchestrator:
    def __init__(
        self,
        *,
        planner: TaskPlanner | None = None,
        dispatcher: TaskDispatcher | None = None,
        aggregator: ResultAggregator | None = None,
        main_agent_runner: MainAgentRunner = run_agent,
    ) -> None:
        self.planner = planner
        self.dispatcher = dispatcher or TaskDispatcher()
        self.aggregator = aggregator or ResultAggregator()
        self.main_agent_runner = main_agent_runner

    async def run(
        self,
        objective: str,
        *,
        workspace_root: Path | None = None,
        response_client: Any | None = None,
        model_name: str | None = None,
        subagent_options: Mapping[str, Any] | None = None,
        main_agent_options: Mapping[str, Any] | None = None,
        event_sink: EventSink | None = None,
    ) -> MultiAgentRunResult:
        normalized_objective = objective.strip()
        if not normalized_objective:
            raise ValueError("objective 不能为空")
        root = (workspace_root or Path.cwd()).resolve()
        if not root.is_dir():
            raise ValueError(f"工作区不存在：{root}")

        response_client, model_name = _resolve_model(response_client, model_name)
        main_options = dict(main_agent_options or {})
        reserved = RESERVED_MAIN_OPTIONS & main_options.keys()
        if reserved:
            raise ValueError(f"主 Agent 选项不能覆盖框架字段：{sorted(reserved)}")

        run_id = uuid4().hex
        event_bus = EventBus(
            run_id,
            [
                event_sink
                or JsonlEventSink(Path.cwd() / "artifacts" / "events" / f"multi-{run_id}.jsonl")
            ],
        )
        await event_bus.emit(
            AgentEventType.TRACE_STARTED,
            run_id=run_id,
            agent_id="orchestrator",
            payload={"objective_characters": len(normalized_objective)},
        )
        await event_bus.emit(
            AgentEventType.PLANNING_STARTED,
            run_id=run_id,
            agent_id="orchestrator",
        )
        planning = await self._create_plan(
            normalized_objective,
            response_client=response_client,
            model_name=model_name,
        )
        await event_bus.emit(
            AgentEventType.PLANNING_COMPLETED,
            run_id=run_id,
            agent_id="orchestrator",
            payload={
                "source": planning.source,
                "route": planning.plan.route,
                "task_count": len(planning.plan.tasks),
            },
        )
        if planning.plan.route is TaskRoute.DIRECT:
            return await self._complete_direct(
                normalized_objective,
                planning=planning,
                response_client=response_client,
                model_name=model_name,
                run_id=run_id,
                event_bus=event_bus,
            )

        await event_bus.emit(
            AgentEventType.DISPATCH_STARTED,
            run_id=run_id,
            agent_id="orchestrator",
            payload={"task_ids": [task.id for task in planning.plan.tasks]},
        )
        try:
            subagents = await self.dispatcher.dispatch(
                planning.plan,
                workspace_root=root,
                response_client=response_client,
                model_name=model_name,
                agent_options=subagent_options,
                event_bus=event_bus,
            )
        except Exception as exc:
            await event_bus.emit(
                AgentEventType.TRACE_FAILED,
                run_id=run_id,
                agent_id="orchestrator",
                payload={"stage": "dispatch", "error": str(exc)[:2_000]},
            )
            return MultiAgentRunResult(
                run_id=run_id,
                status=MultiAgentRunStatus.FAILED,
                objective=normalized_objective,
                planning=planning,
                subagents=[],
                error=f"子任务分发失败：{type(exc).__name__}: {exc}",
                warnings=planning.warnings,
                event_count=event_bus.event_count,
                event_artifact_paths=event_bus.artifact_paths,
                event_warnings=event_bus.warnings,
            )

        await event_bus.emit(
            AgentEventType.DISPATCH_COMPLETED,
            run_id=run_id,
            agent_id="orchestrator",
            payload={
                "statuses": {result.task_id: result.status for result in subagents},
            },
        )

        aggregation = self.aggregator.aggregate(
            normalized_objective,
            planning.plan,
            subagents,
        )
        await event_bus.emit(
            AgentEventType.AGGREGATION_COMPLETED,
            run_id=run_id,
            agent_id="orchestrator",
            payload={
                "completed_tasks": aggregation.completed_task_ids,
                "failed_tasks": aggregation.failed_task_ids,
                "conflict_count": len(aggregation.conflicts),
                "truncated": aggregation.truncated,
            },
        )
        warnings = list(planning.warnings)
        if aggregation.truncated:
            warnings.append("子 Agent 证据超过聚合预算，部分内容已截断")
        if aggregation.failed_task_ids:
            warnings.append(f"未完成的子任务：{aggregation.failed_task_ids}")
        if aggregation.conflicts:
            warnings.append("检测到子 Agent 写冲突，已交由主 Agent 重新验证且未自动合并")

        try:
            final_result = await self.main_agent_runner(
                aggregation.main_agent_prompt,
                workspace_root=root,
                response_client=response_client,
                model_name=model_name,
                working_memory_objective=normalized_objective,
                event_bus=event_bus,
                agent_id="main",
                **main_options,
            )
        except Exception as exc:
            await event_bus.emit(
                AgentEventType.TRACE_FAILED,
                run_id=run_id,
                agent_id="orchestrator",
                payload={"stage": "main_agent", "error": str(exc)[:2_000]},
            )
            return MultiAgentRunResult(
                run_id=run_id,
                status=MultiAgentRunStatus.FAILED,
                objective=normalized_objective,
                planning=planning,
                subagents=subagents,
                aggregation=aggregation,
                error=f"主 Agent 执行失败：{type(exc).__name__}: {exc}",
                warnings=warnings,
                event_count=event_bus.event_count,
                event_artifact_paths=event_bus.artifact_paths,
                event_warnings=event_bus.warnings,
            )

        if final_result.status is AgentRunStatus.FAILED:
            await event_bus.emit(
                AgentEventType.TRACE_FAILED,
                run_id=run_id,
                agent_id="orchestrator",
                payload={"stage": "main_agent", "error": final_result.error or ""},
            )
            return MultiAgentRunResult(
                run_id=run_id,
                status=MultiAgentRunStatus.FAILED,
                objective=normalized_objective,
                planning=planning,
                subagents=subagents,
                aggregation=aggregation,
                final_agent_result=final_result,
                changed_files=final_result.changed_files,
                tests_passed=final_result.tests_passed,
                quality_checks_passed=final_result.quality_checks_passed,
                error=final_result.error or "主 Agent 没有完成任务",
                warnings=warnings,
                event_count=event_bus.event_count,
                event_artifact_paths=event_bus.artifact_paths,
                event_warnings=event_bus.warnings,
            )

        fully_completed = (
            all(result.status is SubAgentStatus.COMPLETED for result in subagents)
            and not aggregation.conflicts
        )
        final_status = (
            MultiAgentRunStatus.COMPLETED if fully_completed else MultiAgentRunStatus.PARTIAL
        )
        await event_bus.emit(
            AgentEventType.TRACE_COMPLETED,
            run_id=run_id,
            agent_id="orchestrator",
            payload={
                "status": final_status,
                "changed_files": final_result.changed_files,
                "tests_passed": final_result.tests_passed,
                "quality_checks_passed": final_result.quality_checks_passed,
            },
        )
        return MultiAgentRunResult(
            run_id=run_id,
            status=final_status,
            objective=normalized_objective,
            planning=planning,
            subagents=subagents,
            aggregation=aggregation,
            final_agent_result=final_result,
            final_answer=final_result.final_answer,
            changed_files=final_result.changed_files,
            tests_passed=final_result.tests_passed,
            quality_checks_passed=final_result.quality_checks_passed,
            warnings=warnings,
            event_count=event_bus.event_count,
            event_artifact_paths=event_bus.artifact_paths,
            event_warnings=event_bus.warnings,
        )

    async def _complete_direct(
        self,
        objective: str,
        *,
        planning: TaskPlanningResult,
        response_client: Any,
        model_name: str,
        run_id: str,
        event_bus: EventBus,
    ) -> MultiAgentRunResult:
        """不接触仓库和工具，直接完成普通对话。"""

        agent_id = "direct"
        await event_bus.emit(
            AgentEventType.AGENT_STARTED,
            run_id=run_id,
            agent_id=agent_id,
            payload={"route": TaskRoute.DIRECT},
        )
        await event_bus.emit(
            AgentEventType.MODEL_REQUESTED,
            run_id=run_id,
            agent_id=agent_id,
            payload={"model": model_name, "tools_available": 0},
        )
        try:
            response = await asyncio.to_thread(
                response_client.responses.create,
                model=model_name,
                input=[
                    {"role": "developer", "content": DIRECT_RESPONSE_INSTRUCTIONS},
                    {"role": "user", "content": objective},
                ],
                timeout=60.0,
            )
            output_text = getattr(response, "output_text", None)
            final_answer = output_text.strip() if isinstance(output_text, str) else ""
            if not final_answer:
                raise ValueError("模型没有返回直接回复文本")
        except Exception as exc:
            error = f"直接回复失败：{type(exc).__name__}: {exc}"
            await event_bus.emit(
                AgentEventType.AGENT_FAILED,
                run_id=run_id,
                agent_id=agent_id,
                payload={"error": error[:2_000]},
            )
            await event_bus.emit(
                AgentEventType.TRACE_FAILED,
                run_id=run_id,
                agent_id="orchestrator",
                payload={"stage": "direct_response", "error": error[:2_000]},
            )
            return MultiAgentRunResult(
                run_id=run_id,
                status=MultiAgentRunStatus.FAILED,
                objective=objective,
                planning=planning,
                subagents=[],
                error=error,
                warnings=planning.warnings,
                event_count=event_bus.event_count,
                event_artifact_paths=event_bus.artifact_paths,
                event_warnings=event_bus.warnings,
            )

        await event_bus.emit(
            AgentEventType.MODEL_RESPONDED,
            run_id=run_id,
            agent_id=agent_id,
            payload={"output_characters": len(final_answer)},
        )
        final_result = AgentRunResult(
            status=AgentRunStatus.COMPLETED,
            final_answer=final_answer,
            rounds=0,
        )
        await event_bus.emit(
            AgentEventType.AGENT_COMPLETED,
            run_id=run_id,
            agent_id=agent_id,
            payload={"changed_files": [], "tool_calls": 0},
        )
        await event_bus.emit(
            AgentEventType.TRACE_COMPLETED,
            run_id=run_id,
            agent_id="orchestrator",
            payload={
                "status": MultiAgentRunStatus.COMPLETED,
                "route": TaskRoute.DIRECT,
                "changed_files": [],
                "tests_passed": False,
                "quality_checks_passed": False,
            },
        )
        return MultiAgentRunResult(
            run_id=run_id,
            status=MultiAgentRunStatus.COMPLETED,
            objective=objective,
            planning=planning,
            subagents=[],
            final_agent_result=final_result,
            final_answer=final_answer,
            warnings=planning.warnings,
            event_count=event_bus.event_count,
            event_artifact_paths=event_bus.artifact_paths,
            event_warnings=event_bus.warnings,
        )

    async def _create_plan(
        self,
        objective: str,
        *,
        response_client: Any,
        model_name: str,
    ) -> TaskPlanningResult:
        planner = self.planner or LLMTaskPlanner(response_client, model_name)
        try:
            return await planner.plan(objective)
        except Exception as exc:
            return TaskPlanningResult(
                source=PlanSource.FALLBACK,
                plan=build_fallback_plan(objective),
                warnings=[f"Planner 异常，已使用确定性计划：{type(exc).__name__}: {exc}"],
            )


async def run_multi_agent(
    objective: str,
    *,
    workspace_root: Path | None = None,
    response_client: Any | None = None,
    model_name: str | None = None,
    planner: TaskPlanner | None = None,
    dispatcher: TaskDispatcher | None = None,
    aggregator: ResultAggregator | None = None,
    subagent_options: Mapping[str, Any] | None = None,
    main_agent_options: Mapping[str, Any] | None = None,
    event_sink: EventSink | None = None,
) -> MultiAgentRunResult:
    orchestrator = MultiAgentOrchestrator(
        planner=planner,
        dispatcher=dispatcher,
        aggregator=aggregator,
    )
    return await orchestrator.run(
        objective,
        workspace_root=workspace_root,
        response_client=response_client,
        model_name=model_name,
        subagent_options=subagent_options,
        main_agent_options=main_agent_options,
        event_sink=event_sink,
    )


def _resolve_model(response_client: Any | None, model_name: str | None) -> tuple[Any, str]:
    if response_client is None or model_name is None:
        from bit_agent.llm.client import client
        from bit_agent.llm.client import model_name as configured_model_name

        response_client = response_client or client
        model_name = model_name or configured_model_name
    if not model_name:
        raise RuntimeError("缺少环境变量：MODEL_NAME")
    return response_client, model_name
