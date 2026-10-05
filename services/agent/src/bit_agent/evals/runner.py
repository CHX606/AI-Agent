"""在临时工作区运行 Agent，并由独立 OS 沙箱测试和文件快照判分。"""

import tempfile
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Any
from uuid import uuid4

from bit_agent.agent.result import AgentRunResult, AgentRunStatus
from bit_agent.agent.runtime import run_agent
from bit_agent.evals.artifacts import write_artifacts
from bit_agent.evals.evidence import build_verified_evidence
from bit_agent.evals.models import EvalCase, EvalResult
from bit_agent.evals.scoring import collect_violations, verification_error
from bit_agent.evals.workspace import (
    build_unified_diff,
    compare_snapshots,
    path_matches,
    prepare_workspace,
    snapshot_workspace,
)
from bit_agent.memory import ConsolidationStatus, MemoryConsolidationResult, MemoryConsolidator
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolResult
from bit_agent.tools.run_tests import run_tests

AgentRunner = Callable[..., Awaitable[AgentRunResult]]
VerificationRunner = Callable[..., Awaitable[ToolResult]]

__all__ = [
    "EvalRunner",
    "build_unified_diff",
    "compare_snapshots",
    "path_matches",
    "snapshot_workspace",
]


class EvalRunner:
    """为一个 EvalCase 创建一次性工作区、运行 Agent 并独立判分。"""

    def __init__(
        self,
        results_root: Path,
        *,
        agent_runner: AgentRunner = run_agent,
        verification_runner: VerificationRunner = run_tests,
        temporary_root: Path | None = None,
        memory_consolidator: MemoryConsolidator | None = None,
        memory_project_id: str | None = None,
        memory_user_id: str | None = None,
    ) -> None:
        self.results_root = results_root.resolve()
        self.results_root.mkdir(parents=True, exist_ok=True)
        self.agent_runner = agent_runner
        self.verification_runner = verification_runner
        self.temporary_root = temporary_root.resolve() if temporary_root is not None else None
        if self.temporary_root is not None:
            self.temporary_root.mkdir(parents=True, exist_ok=True)
        self.memory_consolidator = memory_consolidator
        self.memory_project_id = memory_project_id
        self.memory_user_id = memory_user_id

    async def run(
        self,
        case: EvalCase,
        *,
        agent_options: Mapping[str, Any] | None = None,
    ) -> EvalResult:
        """执行评测；返回前临时工作区一定已经被清理。"""
        run_id = uuid4().hex
        directory = self.results_root / case.name / run_id
        directory.mkdir(parents=True)
        with tempfile.TemporaryDirectory(
            prefix=f"bit-agent-eval-{case.name}-",
            dir=self.temporary_root,
        ) as temporary_directory:
            # TEMP 可能是 8.3 短名，统一成工具内部使用的规范长路径。
            workspace = Path(temporary_directory).resolve() / "workspace"
            before = prepare_workspace(case, workspace)
            evaluation, diff = await self._evaluate_workspace(
                case,
                run_id,
                directory,
                workspace,
                before,
                dict(agent_options or {}),
            )
            write_artifacts(evaluation, diff)
        return evaluation

    async def _run_agent(
        self,
        case: EvalCase,
        workspace: Path,
        options: dict[str, Any],
    ) -> AgentRunResult:
        try:
            return await self.agent_runner(case.prompt, workspace_root=workspace, **options)
        except Exception as exc:
            return AgentRunResult(
                status=AgentRunStatus.FAILED,
                rounds=0,
                error=f"{type(exc).__name__}: {exc}",
            )

    async def _verify(self, case: EvalCase, run_id: str, workspace: Path) -> ToolResult:
        context = ToolContext(
            workspace_root=workspace,
            tool_call_id="independent-verification",
            timeout_seconds=case.verification_timeout_seconds,
            task_id=f"eval-{case.name}-{run_id[:8]}",
        )
        try:
            return await self.verification_runner(context, case.test_target)
        except Exception as exc:
            return verification_error(f"{type(exc).__name__}: {exc}")

    async def _evaluate_workspace(
        self,
        case: EvalCase,
        run_id: str,
        directory: Path,
        workspace: Path,
        before: dict[str, str],
        options: dict[str, Any],
    ) -> tuple[EvalResult, str]:
        agent_result = await self._run_agent(case, workspace, options)
        after = snapshot_workspace(workspace, case.ignored_paths)
        changes = compare_snapshots(before, after)
        verification_result = await self._verify(case, run_id, workspace)
        violations = collect_violations(case, agent_result, verification_result, changes)
        diff = build_unified_diff(case.fixture_path, workspace, changes)
        memory_consolidation = None
        if not violations and self.memory_consolidator is not None:
            memory_consolidation = await self._consolidate(
                run_id,
                case,
                agent_result,
                verification_result,
                diff,
                directory,
            )
        evaluation = EvalResult(
            run_id=run_id,
            case_name=case.name,
            passed=not violations,
            agent_result=agent_result,
            verification_result=verification_result,
            file_changes=changes,
            violations=violations,
            artifact_directory=directory,
            memory_consolidation=memory_consolidation,
        )
        return evaluation, diff

    async def _consolidate(
        self,
        run_id: str,
        case: EvalCase,
        agent_result: AgentRunResult,
        verification_result: ToolResult,
        diff: str,
        directory: Path,
    ) -> MemoryConsolidationResult:
        assert self.memory_consolidator is not None
        evidence = build_verified_evidence(
            run_id=run_id,
            case=case,
            agent_result=agent_result,
            verification_result=verification_result,
            diff=diff,
            project_id=self.memory_project_id or case.name,
            user_id=self.memory_user_id,
            source_artifact_uri=directory.as_uri(),
        )
        try:
            return await self.memory_consolidator.consolidate(evidence)
        except Exception as exc:
            return MemoryConsolidationResult(
                run_id=run_id,
                status=ConsolidationStatus.FAILED,
                error=f"{type(exc).__name__}: {exc}",
            )
