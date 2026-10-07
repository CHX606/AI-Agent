from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from agents import Agent as Agent
from agents import OpenAIChatCompletionsModel as OpenAIChatCompletionsModel
from agents import OpenAIResponsesModel as OpenAIResponsesModel

from bit_agent.agent.result import AgentRunResult
from bit_agent.agent.tool_dispatch import (
    DEFAULT_TOOL_TIMEOUT_SECONDS as DEFAULT_TOOL_TIMEOUT_SECONDS,
)
from bit_agent.agent.tool_dispatch import TOOL_HANDLERS as TOOL_HANDLERS
from bit_agent.agent.tool_dispatch import ToolHandler as ToolHandler
from bit_agent.agent.tool_dispatch import execute_tool as execute_tool
from bit_agent.agent.tool_dispatch import tool_error_result as tool_error_result
from bit_agent.agent.tool_dispatch import tool_operation as tool_operation
from bit_agent.agent.verification import (
    VERIFICATION_REQUIRED_MESSAGE as VERIFICATION_REQUIRED_MESSAGE,
)
from bit_agent.context import ContextManagementPolicy, ContextManager
from bit_agent.llm.tool_schemas import TOOL_SCHEMAS as TOOL_SCHEMAS
from bit_agent.memory import MemoryRetriever, WorkingMemoryStore
from bit_agent.observability import EventBus, EventSink
from bit_agent.tool_provider import ToolProvider

from .run_completion import RunCompletion
from .run_events import RunEvents
from .run_input import RunInput
from .run_model import RunModel
from .run_protocol import LONG_TERM_MEMORY_PREFIX as LONG_TERM_MEMORY_PREFIX
from .run_protocol import MAX_TOOL_ROUNDS, Interaction, RecordItems, SaveProgress
from .run_protocol import REASONING_EFFORTS as REASONING_EFFORTS
from .run_protocol import _model_failure_message as _model_failure_message
from .run_protocol import _summary_model as _summary_model
from .run_setup import prepare_run
from .run_state import RunState
from .run_tools import RunTools


class _AgentRun(RunState, RunEvents, RunInput, RunTools, RunModel, RunCompletion):
    pass


async def run_agent(
    prompt: str,
    *,
    images: list[dict[str, str]] | None = None,
    attachments: list[dict[str, str]] | None = None,
    workspace_root: Path | None = None,
    max_tool_rounds: int = MAX_TOOL_ROUNDS,
    response_client: Any | None = None,
    model_name: str | None = None,
    model_api: str | None = None,
    reasoning_effort: str | None = None,
    tool_provider: ToolProvider | None = None,
    thread_id: str | None = None,
    working_memory_objective: str | None = None,
    working_memory_store: WorkingMemoryStore | None = None,
    working_memory_ttl_seconds: int = 86_400,
    memory_retriever: MemoryRetriever | None = None,
    memory_project_id: str | None = None,
    memory_user_id: str | None = None,
    context_manager: ContextManager | None = None,
    context_policy: ContextManagementPolicy | None = None,
    context_artifact_directory: Path | None = None,
    event_bus: EventBus | None = None,
    event_sink: EventSink | None = None,
    agent_id: str = "main",
    task_id: str | None = None,
    initial_state: dict[str, Any] | None = None,
    save_progress: SaveProgress | None = None,
    pending_intents: list[dict[str, Any]] | None = None,
    record_items: RecordItems | None = None,
    runtime_instructions: str | None = None,
    require_independent_acceptance: bool = False,
    interaction: Interaction | None = None,
) -> AgentRunResult:
    """循环请求模型和执行工具，并返回整次任务的结构化回执。"""
    options = prepare_run(locals())
    return await _AgentRun(options).execute()


def main() -> None:
    workspace_text = input("工作区路径：").strip()
    if not workspace_text:
        raise ValueError("工作区路径不能为空")
    workspace_root = Path(workspace_text).expanduser().resolve()
    if not workspace_root.is_dir():
        raise ValueError(f"工作区不存在：{workspace_root}")
    prompt = input("你：").strip()
    result = asyncio.run(run_agent(prompt, workspace_root=workspace_root))
    print(result.model_dump_json(indent=2))


if __name__ == "__main__":
    main()
