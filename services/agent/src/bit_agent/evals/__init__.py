"""Bit Agent 的隔离、可重复 Agent 评测。"""

from bit_agent.evals.models import (
    DEFAULT_IGNORED_PATHS,
    DEFAULT_IMMUTABLE_PATHS,
    EvalCase,
    EvalResult,
    EvalViolation,
    FileChanges,
)
from bit_agent.evals.runner import (
    EvalRunner,
    build_unified_diff,
    compare_snapshots,
    path_matches,
    snapshot_workspace,
)

__all__ = [
    "DEFAULT_IGNORED_PATHS",
    "DEFAULT_IMMUTABLE_PATHS",
    "EvalCase",
    "EvalResult",
    "EvalRunner",
    "EvalViolation",
    "FileChanges",
    "build_unified_diff",
    "compare_snapshots",
    "path_matches",
    "snapshot_workspace",
]
