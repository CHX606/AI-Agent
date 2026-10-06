from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any

from bit_agent.agent.runtime import run_agent as run_agent
from bit_agent.memory import WorkingMemoryStore
from bit_agent.runtime.application.capacity import WorkspaceReservations
from bit_agent.runtime.application.interaction import (
    TaskInteraction,
)
from bit_agent.runtime.application.long_term_memory import ProjectMemory
from bit_agent.runtime.application.ports import (
    AcceptanceWorkspaceFactory,
    GitPort,
    JournalFactory,
    ProjectInstructionsReader,
    ProjectVerifier,
    StoragePort,
)
from bit_agent.tool_provider.external import build_servers as build_servers

from .change_commands import ChangeCommands
from .model_commands import ModelCommands
from .service_protocol import TERMINAL as TERMINAL
from .service_protocol import TaskEventSink as TaskEventSink
from .session_commands import SessionCommands
from .task_execution import TaskExecution
from .task_observation import TaskObservation
from .task_submission import TaskSubmission


class AgentRuntime(
    TaskSubmission, TaskExecution, TaskObservation, SessionCommands, ChangeCommands, ModelCommands
):
    def __init__(
        self,
        *,
        concurrency: int = 2,
        storage: StoragePort,
        memory: WorkingMemoryStore,
        journal_factory: JournalFactory,
        verifier: ProjectVerifier,
        acceptance_workspace: AcceptanceWorkspaceFactory | None = None,
        long_term_memory: ProjectMemory | None = None,
        project_instructions: ProjectInstructionsReader | None = None,
        git: GitPort | None = None,
    ) -> None:
        if concurrency < 1:
            raise ValueError("并发数量必须大于 0")
        self.storage = storage
        self.memory = memory
        self.journal_factory = journal_factory
        self.verifier = verifier
        self.acceptance_workspace = acceptance_workspace
        self.long_term_memory = long_term_memory
        self.project_instructions = project_instructions
        self.git = git
        # 桌面“外部工具”里配置的 MCP Server；只保存在内存里，密钥不落盘。
        self.mcp_servers: list[dict[str, Any]] = []
        # 任务结束后在后台提炼经验，不拖慢任务本身；关闭时统一收尾。
        self._background: set[asyncio.Task[None]] = set()
        self._slots = asyncio.Semaphore(concurrency)
        self._workspaces = WorkspaceReservations()
        self._running: dict[str, asyncio.Task[None]] = {}
        self._interactions: dict[str, TaskInteraction] = {}
        self._sessions: dict[str, str] = {}
        # 用户选了“本对话内都批准”的操作类别，按对话保存在内存里；重启应用后重新询问。
        self._session_approvals: dict[str, set[str]] = {}
        self._submission_lock = asyncio.Lock()
        self._closing = False
        self._diagnostic_monitor: asyncio.Task[None] | None = None

    async def start(self) -> None:
        await self.storage.call("recover")
        self._diagnostic_monitor = asyncio.create_task(self._observe_slow_tasks())

    async def close(self) -> None:
        self._closing = True
        if self._diagnostic_monitor is not None:
            self._diagnostic_monitor.cancel()
            with suppress(asyncio.CancelledError):
                await self._diagnostic_monitor
        executions = list(self._running.values())
        for execution in executions:
            if not execution.cancelling():
                execution.cancel()
        await asyncio.gather(*executions, return_exceptions=True)
        # 后台提炼经验只是锦上添花，关闭时直接取消，不拖延退出。
        background = list(self._background)
        for job in background:
            job.cancel()
        await asyncio.gather(*background, return_exceptions=True)
        await asyncio.to_thread(self.storage.close)
        if self.long_term_memory is not None:
            await asyncio.to_thread(self.long_term_memory.close)
