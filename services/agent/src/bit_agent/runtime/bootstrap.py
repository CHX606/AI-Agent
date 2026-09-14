"""Composition root: choose concrete persistence adapters here, not in business services."""

from functools import partial
from pathlib import Path

from bit_agent.runtime.application.service import AgentRuntime
from bit_agent.runtime.infrastructure.acceptance import AcceptanceWorkspace
from bit_agent.runtime.infrastructure.changes import ChangeJournal
from bit_agent.runtime.infrastructure.storage import (
    LocalStorage,
    SQLiteWorkingMemoryStore,
    default_data_directory,
)
from bit_agent.runtime.infrastructure.verification import verify_project


def create_runtime(directory: Path | None = None, *, concurrency: int = 2) -> AgentRuntime:
    storage = LocalStorage(directory or default_data_directory())
    try:
        return AgentRuntime(storage=storage, memory=SQLiteWorkingMemoryStore(storage),
                            concurrency=concurrency, journal_factory=ChangeJournal,
                            verifier=verify_project,
                            acceptance_workspace=partial(
                                AcceptanceWorkspace, excluded_roots=(storage.directory,)
                            ))
    except Exception:
        storage.close()
        raise
