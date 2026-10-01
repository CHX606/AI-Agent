"""Composition root: choose concrete persistence adapters here, not in business services."""

import os
from functools import partial
from pathlib import Path

from bit_agent.memory import LLMMemoryCandidateExtractor, SQLiteLongTermMemoryStore
from bit_agent.runtime.application.long_term_memory import ProjectMemory
from bit_agent.runtime.application.service import AgentRuntime
from bit_agent.runtime.infrastructure.acceptance import AcceptanceWorkspace
from bit_agent.runtime.infrastructure.changes import ChangeJournal
from bit_agent.runtime.infrastructure.git import GitRepository
from bit_agent.runtime.infrastructure.project_instructions import read_project_instructions
from bit_agent.runtime.infrastructure.storage import (
    LocalStorage,
    SQLiteWorkingMemoryStore,
    default_data_directory,
)
from bit_agent.runtime.infrastructure.verification import verify_project


def _memory_extractor() -> LLMMemoryCandidateExtractor:
    # 每次提炼时读取当前模型配置，用户在界面里改了模型也能生效。
    from bit_agent.llm.client import client, model_name

    return LLMMemoryCandidateExtractor(client, model_name)


def create_runtime(directory: Path | None = None, *, concurrency: int = 2) -> AgentRuntime:
    storage = LocalStorage(directory or default_data_directory())
    long_term_memory = None
    try:
        # BIT_AGENT_LONG_TERM_MEMORY=0 关闭长期记忆：不召回，也不在任务后提炼经验。
        if os.getenv("BIT_AGENT_LONG_TERM_MEMORY", "1") != "0":
            long_term_memory = ProjectMemory(
                SQLiteLongTermMemoryStore(storage.directory / "long_term_memory.sqlite3"),
                _memory_extractor,
            )
        return AgentRuntime(
            storage=storage,
            memory=SQLiteWorkingMemoryStore(storage),
            concurrency=concurrency,
            journal_factory=ChangeJournal,
            verifier=verify_project,
            acceptance_workspace=partial(AcceptanceWorkspace, excluded_roots=(storage.directory,)),
            long_term_memory=long_term_memory,
            project_instructions=read_project_instructions,
            git=GitRepository(),
        )
    except Exception:
        if long_term_memory is not None:
            long_term_memory.close()
        storage.close()
        raise
