"""在临时工作区运行 Agent，并由独立 Docker 测试和文件快照判分。"""

import difflib
import hashlib
import os
import shutil
import tempfile
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path, PurePosixPath
from typing import Any
from uuid import uuid4

from bit_agent.agent.result import AgentRunResult, AgentRunStatus
from bit_agent.agent.runtime import run_agent
from bit_agent.evals.models import EvalCase, EvalResult, EvalViolation, FileChanges
from bit_agent.memory import (
    ConsolidationStatus,
    MemoryConsolidationResult,
    MemoryConsolidator,
    TestStatus,
    VerifiedRunEvidence,
    WorkingMemory,
)
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus
from bit_agent.tools.run_tests import run_tests

AgentRunner = Callable[..., Awaitable[AgentRunResult]]
VerificationRunner = Callable[..., Awaitable[ToolResult]]


def _is_junction(path: Path) -> bool:
    is_junction = getattr(path, "is_junction", None)
    return bool(is_junction and is_junction())


def path_matches(path: str, patterns: list[str]) -> bool:
    """判断 POSIX 相对路径是否命中一条精确路径或 glob 规则。"""
    candidate = PurePosixPath(path)
    for pattern in patterns:
        if candidate.match(pattern) or (
            pattern.startswith("**/") and candidate.match(pattern[3:])
        ):
            return True
        if pattern.endswith("/**"):
            directory = pattern[:-3].rstrip("/")
            if not any(character in directory for character in "*?[") and (
                path == directory or path.startswith(f"{directory}/")
            ):
                return True
    return False


def snapshot_workspace(workspace_root: Path, ignored_paths: list[str]) -> dict[str, str]:
    """用相对路径和 SHA-256 记录工作区内所有受评测文件。"""
    root = workspace_root.resolve()
    snapshot: dict[str, str] = {}

    for current_root, directory_names, file_names in os.walk(root, followlinks=False):
        current = Path(current_root)
        safe_directories: list[str] = []
        for name in sorted(directory_names, key=lambda value: (value.casefold(), value)):
            directory = current / name
            relative = directory.relative_to(root).as_posix()
            if directory.is_symlink() or _is_junction(directory):
                raise ValueError(f"评测工作区不允许包含符号链接或目录联接：{relative}")
            if not path_matches(f"{relative}/placeholder", ignored_paths):
                safe_directories.append(name)
        directory_names[:] = safe_directories

        for name in sorted(file_names, key=lambda value: (value.casefold(), value)):
            file_path = current / name
            relative = file_path.relative_to(root).as_posix()
            if file_path.is_symlink() or _is_junction(file_path):
                raise ValueError(f"评测工作区不允许包含符号链接或目录联接：{relative}")
            if path_matches(relative, ignored_paths):
                continue
            digest = hashlib.sha256(file_path.read_bytes()).hexdigest()
            snapshot[relative] = digest

    return dict(sorted(snapshot.items()))


def compare_snapshots(before: Mapping[str, str], after: Mapping[str, str]) -> FileChanges:
    """计算新增、修改和删除文件，结果始终稳定排序。"""
    before_paths = set(before)
    after_paths = set(after)
    return FileChanges(
        added=sorted(after_paths - before_paths),
        modified=sorted(
            path for path in before_paths & after_paths if before[path] != after[path]
        ),
        deleted=sorted(before_paths - after_paths),
    )


def _read_diff_lines(path: Path) -> list[str] | None:
    if not path.is_file():
        return []
    try:
        return path.read_text(encoding="utf-8").splitlines(keepends=True)
    except UnicodeDecodeError:
        return None


def build_unified_diff(before_root: Path, after_root: Path, changes: FileChanges) -> str:
    """为实际文件变化生成适合保存和人工审核的 unified diff。"""
    sections: list[str] = []
    for relative in changes.all_paths:
        before_path = before_root / relative
        after_path = after_root / relative
        before_lines = _read_diff_lines(before_path)
        after_lines = _read_diff_lines(after_path)
        if before_lines is None or after_lines is None:
            sections.append(f"Binary files a/{relative} and b/{relative} differ\n")
            continue
        sections.extend(
            difflib.unified_diff(
                before_lines,
                after_lines,
                fromfile=f"a/{relative}",
                tofile=f"b/{relative}",
            )
        )
    return "".join(sections)


def _verification_error(message: str) -> ToolResult:
    return ToolResult(
        tool_call_id="independent-verification",
        tool_name="run_tests",
        status=ToolStatus.ERROR,
        error=ToolError(
            code="VERIFICATION_RUNNER_ERROR",
            message=message,
            retryable=False,
        ),
        metadata=ToolMetadata(duration_ms=0),
    )


def _collect_violations(
    case: EvalCase,
    agent_result: AgentRunResult,
    verification_result: ToolResult,
    changes: FileChanges,
) -> list[EvalViolation]:
    violations: list[EvalViolation] = []

    if agent_result.status is not AgentRunStatus.COMPLETED:
        violations.append(
            EvalViolation(
                code="AGENT_FAILED",
                message=agent_result.error or "Agent 没有完成任务",
            )
        )
    if case.require_agent_tests and not agent_result.tests_passed:
        violations.append(
            EvalViolation(
                code="AGENT_TESTS_NOT_PASSED",
                message="Agent 运行轨迹中没有最近代码状态的成功测试记录",
            )
        )
    if verification_result.status is not ToolStatus.SUCCESS:
        message = (
            verification_result.error.message
            if verification_result.error is not None
            else "独立 Docker 测试没有通过"
        )
        violations.append(
            EvalViolation(
                code="INDEPENDENT_TESTS_FAILED",
                message=message,
            )
        )
    if case.require_changes and not changes.all_paths:
        violations.append(
            EvalViolation(
                code="NO_FILES_CHANGED",
                message="该评测要求修改代码，但工作区没有产生文件变化",
            )
        )

    for path in changes.all_paths:
        if path_matches(path, case.immutable_paths):
            violations.append(
                EvalViolation(
                    code="IMMUTABLE_PATH_CHANGED",
                    message="修改了本次评测规定的不可变文件",
                    path=path,
                )
            )
        elif case.allowed_paths and not path_matches(path, case.allowed_paths):
            violations.append(
                EvalViolation(
                    code="PATH_OUTSIDE_ALLOWED_SCOPE",
                    message="修改路径不在本次评测允许的范围内",
                    path=path,
                )
            )

    reported = set(agent_result.changed_files)
    actual = set(changes.all_paths)
    if reported != actual:
        violations.append(
            EvalViolation(
                code="CHANGE_REPORT_MISMATCH",
                message=(
                    "Agent 回执与真实文件变化不一致："
                    f"reported={sorted(reported)}, actual={sorted(actual)}"
                ),
            )
        )

    return violations


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
        artifact_directory = self.results_root / case.name / run_id
        artifact_directory.mkdir(parents=True)
        options = dict(agent_options or {})

        with tempfile.TemporaryDirectory(
            prefix=f"bit-agent-eval-{case.name}-",
            dir=self.temporary_root,
        ) as temporary_directory:
            workspace = Path(temporary_directory) / "workspace"
            # 在复制前先拒绝 Fixture 中的链接，避免 copytree 跟随到工作区外。
            fixture_snapshot = snapshot_workspace(case.fixture_path, case.ignored_paths)
            shutil.copytree(case.fixture_path, workspace)
            before = snapshot_workspace(workspace, case.ignored_paths)
            if before != fixture_snapshot:
                raise RuntimeError("Fixture 复制结果与原始文件快照不一致")

            try:
                agent_result = await self.agent_runner(
                    case.prompt,
                    workspace_root=workspace,
                    **options,
                )
            except Exception as exc:
                agent_result = AgentRunResult(
                    status=AgentRunStatus.FAILED,
                    rounds=0,
                    error=f"{type(exc).__name__}: {exc}",
                )

            after = snapshot_workspace(workspace, case.ignored_paths)
            changes = compare_snapshots(before, after)

            verification_context = ToolContext(
                workspace_root=workspace,
                tool_call_id="independent-verification",
                timeout_seconds=case.verification_timeout_seconds,
                task_id=f"eval-{case.name}-{run_id[:8]}",
            )
            try:
                verification_result = await self.verification_runner(
                    verification_context,
                    case.test_target,
                )
            except Exception as exc:
                verification_result = _verification_error(f"{type(exc).__name__}: {exc}")

            violations = _collect_violations(
                case,
                agent_result,
                verification_result,
                changes,
            )
            diff = build_unified_diff(case.fixture_path, workspace, changes)
            memory_consolidation = None
            if not violations and self.memory_consolidator is not None:
                evidence = _build_verified_evidence(
                    run_id=run_id,
                    case=case,
                    agent_result=agent_result,
                    verification_result=verification_result,
                    diff=diff,
                    project_id=self.memory_project_id or case.name,
                    user_id=self.memory_user_id,
                    source_artifact_uri=artifact_directory.as_uri(),
                )
                try:
                    memory_consolidation = await self.memory_consolidator.consolidate(evidence)
                except Exception as exc:
                    memory_consolidation = MemoryConsolidationResult(
                        run_id=run_id,
                        status=ConsolidationStatus.FAILED,
                        error=f"{type(exc).__name__}: {exc}",
                    )

            evaluation = EvalResult(
                run_id=run_id,
                case_name=case.name,
                passed=not violations,
                agent_result=agent_result,
                verification_result=verification_result,
                file_changes=changes,
                violations=violations,
                artifact_directory=artifact_directory,
                memory_consolidation=memory_consolidation,
            )

            (artifact_directory / "result.json").write_text(
                evaluation.model_dump_json(indent=2) + "\n",
                encoding="utf-8",
            )
            (artifact_directory / "agent_result.json").write_text(
                agent_result.model_dump_json(indent=2) + "\n",
                encoding="utf-8",
            )
            (artifact_directory / "verification.json").write_text(
                verification_result.model_dump_json(indent=2) + "\n",
                encoding="utf-8",
            )
            (artifact_directory / "changes.diff").write_text(diff, encoding="utf-8")
            if memory_consolidation is not None:
                (artifact_directory / "memory_consolidation.json").write_text(
                    memory_consolidation.model_dump_json(indent=2) + "\n",
                    encoding="utf-8",
                )

        return evaluation


def _build_verified_evidence(
    *,
    run_id: str,
    case: EvalCase,
    agent_result: AgentRunResult,
    verification_result: ToolResult,
    diff: str,
    project_id: str,
    user_id: str | None,
    source_artifact_uri: str | None = None,
) -> VerifiedRunEvidence:
    working_memory = agent_result.working_memory
    if working_memory is None:
        working_memory = WorkingMemory(
            thread_id=agent_result.thread_id or f"eval-{run_id}",
            objective=case.prompt,
            changed_files=agent_result.changed_files,
            latest_test_status=(
                TestStatus.PASSED if agent_result.tests_passed else TestStatus.NOT_RUN
            ),
            rounds=agent_result.rounds,
        )

    tool_trace = "\n".join(
        record.model_dump_json() for record in agent_result.tool_calls
    )
    return VerifiedRunEvidence(
        run_id=run_id,
        thread_id=working_memory.thread_id,
        project_id=project_id,
        user_id=user_id,
        objective=case.prompt,
        working_memory=working_memory,
        final_answer=agent_result.final_answer or "",
        changed_files=agent_result.changed_files,
        tool_trace_summary=tool_trace[-20_000:],
        diff=diff[-30_000:],
        verification_summary=verification_result.model_dump_json()[-10_000:],
        source_artifact_uri=source_artifact_uri,
        independently_verified=True,
    )
