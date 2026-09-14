from workflow_engine import StepResult, StepStatus, WorkflowResult, render_text, summarize


def sample_result() -> WorkflowResult:
    return WorkflowResult(
        results=(
            StepResult("fetch", StepStatus.SUCCESS, output="ok"),
            StepResult("build", StepStatus.FAILED, error="compiler error"),
            StepResult("deploy", StepStatus.SKIPPED, error="blocked"),
        ),
        layers=(("fetch",), ("build",), ("deploy",)),
    )


def test_summarizes_every_status_in_enum_order() -> None:
    counts = summarize(sample_result())
    assert list(counts) == list(StepStatus)
    assert counts == {
        StepStatus.PENDING: 0,
        StepStatus.RUNNING: 0,
        StepStatus.SUCCESS: 1,
        StepStatus.FAILED: 1,
        StepStatus.SKIPPED: 1,
    }


def test_renders_stable_human_readable_report() -> None:
    assert render_text(sample_result()) == "\n".join(
        (
            "Workflow: FAILED",
            "PENDING (0): -",
            "RUNNING (0): -",
            "SUCCESS (1): fetch",
            "FAILED (1): build",
            "SKIPPED (1): deploy",
        )
    )


def test_reports_success_when_all_steps_succeed() -> None:
    result = WorkflowResult(
        results=(StepResult("only", StepStatus.SUCCESS),),
        layers=(("only",),),
    )
    assert render_text(result).splitlines()[0] == "Workflow: SUCCESS"
