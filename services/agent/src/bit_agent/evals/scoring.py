"""依据运行回执、独立验证与真实文件变化判定评测违规。"""

from bit_agent.agent.result import AgentRunResult, AgentRunStatus
from bit_agent.evals.models import EvalCase, EvalViolation, FileChanges
from bit_agent.evals.workspace import path_matches
from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus


def verification_error(message: str) -> ToolResult:
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


def _agent_violations(case: EvalCase, result: AgentRunResult) -> list[EvalViolation]:
    violations: list[EvalViolation] = []
    if result.status is not AgentRunStatus.COMPLETED:
        violations.append(
            EvalViolation(code="AGENT_FAILED", message=result.error or "Agent 没有完成任务")
        )
    if case.require_agent_tests and not result.tests_passed:
        violations.append(
            EvalViolation(
                code="AGENT_TESTS_NOT_PASSED",
                message="Agent 运行轨迹中没有最近代码状态的成功测试记录",
            )
        )
    return violations


def _execution_violations(
    case: EvalCase, verification_result: ToolResult, changes: FileChanges
) -> list[EvalViolation]:
    violations: list[EvalViolation] = []
    if verification_result.status is not ToolStatus.SUCCESS:
        message = (
            verification_result.error.message
            if verification_result.error is not None
            else "独立 OS 沙箱测试没有通过"
        )
        violations.append(EvalViolation(code="INDEPENDENT_TESTS_FAILED", message=message))
    if case.require_changes and not changes.all_paths:
        violations.append(
            EvalViolation(
                code="NO_FILES_CHANGED",
                message="该评测要求修改代码，但工作区没有产生文件变化",
            )
        )
    return violations


def _path_violations(case: EvalCase, changes: FileChanges) -> list[EvalViolation]:
    violations: list[EvalViolation] = []
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
    return violations


def collect_violations(
    case: EvalCase,
    agent_result: AgentRunResult,
    verification_result: ToolResult,
    changes: FileChanges,
) -> list[EvalViolation]:
    violations = _agent_violations(case, agent_result)
    violations.extend(_execution_violations(case, verification_result, changes))
    violations.extend(_path_violations(case, changes))
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
