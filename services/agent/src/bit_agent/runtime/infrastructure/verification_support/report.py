"""将验证执行结论转换为工具结构化报告。"""

import time

from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus

from .execution import VerificationExecution


def _outcome(run: VerificationExecution) -> str:
    if run.failed:
        return "FAILED"
    if run.unverified:
        return "UNVERIFIED"
    return "PASSED" if run.checks else "NOT_APPLICABLE"


def _error(outcome: str, unverified: list[dict]) -> ToolError | None:
    if outcome == "FAILED":
        return ToolError(
            code="VERIFICATION_FAILED",
            retryable=False,
            message="项目验证未通过：出现了修改前没有的失败，请查看 status 为 FAILED 的检查",
        )
    if outcome != "UNVERIFIED":
        return None
    reasons = "；".join(
        f"{item['reason']}（{'、'.join(item['paths'][:5])}）" for item in unverified
    )
    return ToolError(
        code="VERIFICATION_UNAVAILABLE",
        retryable=False,
        message=f"无法自动验证：{reasons}。不要为了通过验证去修改测试或验证配置；"
        "在最终回答中如实说明哪些改动没有经过验证。",
    )


def verification_report(
    run: VerificationExecution, plan: dict, changed: list[str], started: float
) -> ToolResult:
    if plan["skipped"]:
        run.notes.append("以下文件不需要运行检查：" + "、".join(plan["skipped"][:20]))
    outcome = _outcome(run)
    error = _error(outcome, run.unverified)
    return ToolResult(
        tool_call_id=run.call_id,
        tool_name="verify_project",
        status=ToolStatus.ERROR if error else ToolStatus.SUCCESS,
        error=error,
        output={
            "outcome": outcome,
            "verified": outcome == "PASSED",
            "scope": "baseline",
            "acceptance_verified": False,
            "checks": run.checks,
            "covered_paths": changed,
            "skipped_paths": plan["skipped"],
            "unverified": run.unverified,
            "notes": run.notes,
        },
        metadata=ToolMetadata(duration_ms=int((time.monotonic() - started) * 1000)),
    )
