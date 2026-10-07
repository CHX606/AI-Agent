"""Assemble a task's tools, saved context and instructions before the SDK run."""

import asyncio
from pathlib import Path
from typing import Any

from bit_agent.agent.limits import DEFAULT_MAX_TOOL_ROUNDS
from bit_agent.memory.models import WorkingMemory
from bit_agent.runtime.application.delegation import MODE_INSTRUCTIONS, DelegatingToolProvider
from bit_agent.runtime.application.interaction import INTERACTION_INSTRUCTIONS
from bit_agent.runtime.application.long_term_memory import project_id_for
from bit_agent.runtime.domain.acceptance_policy import ACCEPTANCE_INSTRUCTIONS
from bit_agent.tool_provider.external import ExternalMcpTools

from .service_protocol import TaskEventSink, project_instructions_block


class TaskRunConfiguration:
    async def _saved_context_options(self, session_id: str, task_id: str) -> dict[str, Any]:
        async def save_progress(context: dict[str, Any], memory: WorkingMemory) -> None:
            await self.storage.call("save_progress", session_id, context, memory)

        async def record_items(items: list[Any]) -> None:
            await self.storage.call("append_items", task_id, items)

        return {
            "initial_state": await self.storage.call("load_context", session_id),
            "pending_intents": await self.storage.call("pending_intents", session_id),
            "save_progress": save_progress,
            "record_items": record_items,
        }

    async def _task_project(self, root: Path, task_id: str):
        project = (
            await asyncio.to_thread(self.project_instructions, root)
            if self.project_instructions
            else None
        )
        if project:
            await self.storage.call(
                "event",
                task_id,
                "PROJECT_INSTRUCTIONS_LOADED",
                {"task_id": task_id, "paths": project["paths"], "truncated": project["truncated"]},
            )
        return project

    def _task_instructions(self, task: dict[str, Any], project) -> str:
        acceptance_mode = task.get("acceptance_mode", "always")
        return (
            MODE_INSTRUCTIONS[task["multi_agent_mode"]]
            + INTERACTION_INSTRUCTIONS
            + "修改文件后必须调用 verify_project 完成基础检查。"
            + "它返回 VERIFICATION_UNAVAILABLE 或 NOT_APPLICABLE "
            "表示没有能运行的检查：不要为通过验证去改测试或验证配置，"
            "也不要再调用 verify_task，直接给出最终回答，如实说明哪些改动未经验证。"
            + ACCEPTANCE_INSTRUCTIONS[acceptance_mode if self.acceptance_workspace else "off"]
            + f"本轮权限模式：{task.get('permission_mode', 'confirm')}。"
            + (project_instructions_block(project) if project else "")
        )

    def _task_provider(self, task, control, sink, artifacts, memory, journal):
        from . import service

        session_id = task["session_id"]
        root = Path(task["workspace_root"])

        async def acceptance_context():
            return await self.storage.call("acceptance_context", session_id)

        async def report(event_type: str, data: dict[str, Any]) -> None:
            await self.storage.call(
                "event", task["task_id"], event_type, {"task_id": task["task_id"], **data}
            )

        servers = service.build_servers(self.mcp_servers, root)
        return DelegatingToolProvider(
            root,
            task["multi_agent_mode"],
            sink,
            artifacts,
            control,
            permission_mode=task.get("permission_mode", "confirm"),
            inherited_changes=memory.verification_paths if memory else [],
            journal=journal,
            verifier=self.verifier,
            acceptance_workspace=self.acceptance_workspace,
            acceptance_context=acceptance_context,
            max_tool_rounds=task.get("max_tool_rounds", DEFAULT_MAX_TOOL_ROUNDS),
            external=ExternalMcpTools(servers) if servers else None,
            report=report,
            approved_categories=self._session_approvals.setdefault(session_id, set()),
            acceptance_mode=task.get("acceptance_mode", "always"),
            inherited_changed_lines=memory.verification_changed_lines if memory else 0,
        )

    def _base_run_options(self, task, control, sink, artifacts) -> dict[str, Any]:
        root = Path(task["workspace_root"])
        acceptance_mode = task.get("acceptance_mode", "always")
        return {
            "workspace_root": root,
            "max_tool_rounds": task.get("max_tool_rounds", DEFAULT_MAX_TOOL_ROUNDS),
            "model_name": task.get("model"),
            "reasoning_effort": task.get("reasoning_effort"),
            "thread_id": task["session_id"],
            "working_memory_store": self.memory,
            "interaction": control.boundary,
            "require_independent_acceptance": self.acceptance_workspace is not None
            and acceptance_mode != "off",
            "event_sink": sink,
            "task_id": task["task_id"],
            "context_artifact_directory": artifacts / "main",
            "memory_retriever": self.long_term_memory.retriever()
            if self.long_term_memory
            else None,
            "memory_project_id": project_id_for(root),
            **({"images": task["images"]} if task.get("images") else {}),
            **({"attachments": task["attachments"]} if task.get("attachments") else {}),
        }

    async def _task_run_options(self, task, control):
        root = Path(task["workspace_root"])
        task_id, session_id = task["task_id"], task["session_id"]
        sink = TaskEventSink(self.storage, task_id)
        saved = await self._saved_context_options(session_id, task_id)
        memory = await self.memory.load(session_id)
        artifacts = self.storage.directory / "artifacts" / task_id
        journal = self.journal_factory(root, artifacts)
        provider = self._task_provider(task, control, sink, artifacts, memory, journal)
        project = await self._task_project(root, task_id)
        options = {
            **self._base_run_options(task, control, sink, artifacts),
            **saved,
            "runtime_instructions": self._task_instructions(task, project),
            "tool_provider": provider,
        }
        return options, journal
