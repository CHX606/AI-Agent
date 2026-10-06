from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack
from typing import Any

from bit_agent.agent.result import ToolCallRecord
from bit_agent.agent.verification import VerificationState
from bit_agent.images import readable_objective
from bit_agent.memory import WorkingMemoryTracker
from bit_agent.observability.usage import UsageMeter
from bit_agent.tool_provider import ToolProvider

from .run_protocol import _prepare_history


class RunState:
    def __init__(self, options: dict[str, Any]) -> None:
        self._configure_identity(options)
        self._configure_memory(options)
        self._configure_conversation(options)
        self._configure_tools(options)

    def _configure_identity(self, options: dict[str, Any]) -> None:
        self.prompt = options["prompt"]
        self.images = options["images"]
        self.root = options["root"]
        self.max_tool_rounds = options["max_tool_rounds"]
        self.response_client = options["response_client"]
        self.model_name = options["model_name"]
        self.model_api = options["model_api"]
        self.reasoning_effort = options["reasoning_effort"]
        self.thread_id = options["thread_id"]
        self.restore_thread = options["restore_thread"]
        self.event_bus = options["event_bus"]
        self.run_id = options["run_id"]
        self.agent_id = options["agent_id"]
        self.task_id = options["task_id"]
        self.save_progress = options["save_progress"]
        self.pending_intents = options["pending_intents"] or []
        self.record_items = options["record_items"]
        self.interaction = options["interaction"]

    def _configure_memory(self, options: dict[str, Any]) -> None:
        self.working_memory_objective = options["working_memory_objective"]
        self.memory_store = options["memory_store"]
        self.working_memory_ttl_seconds = options["working_memory_ttl_seconds"]
        self.memory_retriever = options["memory_retriever"]
        self.memory_project_id = options["memory_project_id"]
        self.memory_user_id = options["memory_user_id"]
        self.memory_tracker = WorkingMemoryTracker.create(
            readable_objective(self.working_memory_objective or self.prompt),
            thread_id=self.thread_id,
        )
        self.memory_warnings: list[str] = []
        self.event_warnings: list[str] = []
        self.recalled_memory_ids: list[str] = []
        self.memory_context_tokens = 0
        self.usage = UsageMeter()

    def _configure_conversation(self, options: dict[str, Any]) -> None:
        self.context = options["context_manager"]
        self.conversation, self.interrupted_calls = _prepare_history(
            list((options["initial_state"] or {}).get("history", [])),
            options["runtime_instructions"],
        )
        self.verification = VerificationState(
            require_independent_acceptance=options["require_independent_acceptance"]
        )
        self.applied_interaction_ids: set[str] = set()
        self.state_ready = False
        self.completed_rounds = 0
        self.tool_calls: list[ToolCallRecord] = []

    def _configure_tools(self, options: dict[str, Any]) -> None:
        self._provider_source = options["provider"]
        self.provider: ToolProvider | None = None
        self.model_tools: list[dict[str, Any]] = []
        self.stack = AsyncExitStack()
        self.active_tool_tasks: set[asyncio.Task] = set()
        self.skipped_calls: set[str] = set()
        self.batch_invalidated = False
