"""将已独立验证的评测运行转换为记忆证据。"""

from bit_agent.agent.result import AgentRunResult
from bit_agent.evals.models import EvalCase
from bit_agent.memory import TestStatus, VerifiedRunEvidence, WorkingMemory
from bit_agent.tools.models import ToolResult


def _working_memory(run_id: str, case: EvalCase, agent_result: AgentRunResult) -> WorkingMemory:
    if agent_result.working_memory is not None:
        return agent_result.working_memory
    return WorkingMemory(
        thread_id=agent_result.thread_id or f"eval-{run_id}",
        objective=case.prompt,
        changed_files=agent_result.changed_files,
        latest_test_status=(TestStatus.PASSED if agent_result.tests_passed else TestStatus.NOT_RUN),
        rounds=agent_result.rounds,
    )


def build_verified_evidence(
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
    working_memory = _working_memory(run_id, case, agent_result)

    tool_trace = "\n".join(record.model_dump_json() for record in agent_result.tool_calls)
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
