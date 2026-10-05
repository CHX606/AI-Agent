"""保存评测回执、独立验证结果与文件差异。"""

from bit_agent.evals.models import EvalResult


def write_artifacts(evaluation: EvalResult, diff: str) -> None:
    directory = evaluation.artifact_directory
    (directory / "result.json").write_text(
        evaluation.model_dump_json(indent=2) + "\n",
        encoding="utf-8",
    )
    (directory / "agent_result.json").write_text(
        evaluation.agent_result.model_dump_json(indent=2) + "\n",
        encoding="utf-8",
    )
    (directory / "verification.json").write_text(
        evaluation.verification_result.model_dump_json(indent=2) + "\n",
        encoding="utf-8",
    )
    (directory / "changes.diff").write_text(diff, encoding="utf-8")
    if evaluation.memory_consolidation is not None:
        (directory / "memory_consolidation.json").write_text(
            evaluation.memory_consolidation.model_dump_json(indent=2) + "\n",
            encoding="utf-8",
        )
