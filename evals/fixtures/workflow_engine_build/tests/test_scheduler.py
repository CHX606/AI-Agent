import asyncio

import pytest

from workflow_engine import Step, StepStatus, Workflow, WorkflowRunner


def run(coroutine):
    return asyncio.run(coroutine)


def test_runs_sync_and_async_actions_with_dependency_outputs() -> None:
    def seed(step, dependencies):
        assert dependencies == {}
        return step.payload["value"]

    async def double(_step, dependencies):
        await asyncio.sleep(0)
        return dependencies["seed"] * 2

    workflow = Workflow(
        (
            Step("seed", "seed", payload={"value": 6}),
            Step("double", "double", ("seed",)),
        )
    )
    result = run(WorkflowRunner({"seed": seed, "double": double}).run(workflow))
    assert result.succeeded
    assert result.by_id["double"].output == 12
    with pytest.raises(TypeError):
        result.by_id["double"] = result.by_id["seed"]


def test_only_passes_direct_successful_dependency_outputs() -> None:
    observed = None

    def action(step, dependencies):
        nonlocal observed
        if step.id == "final":
            observed = dict(dependencies)
        return step.id

    workflow = Workflow(
        (
            Step("root", "run"),
            Step("middle", "run", ("root",)),
            Step("final", "run", ("middle",)),
        )
    )
    run(WorkflowRunner({"run": action}).run(workflow))
    assert observed == {"middle": "middle"}


def test_enforces_concurrency_limit() -> None:
    active = 0
    peak = 0

    async def tracked(_step, _dependencies):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.02)
        active -= 1

    workflow = Workflow(tuple(Step(f"step-{index}", "run") for index in range(8)))
    result = run(WorkflowRunner({"run": tracked}, max_concurrency=3).run(workflow))
    assert result.succeeded
    assert peak == 3


@pytest.mark.parametrize("value", [0, -1, True])
def test_rejects_invalid_concurrency(value) -> None:
    with pytest.raises(ValueError):
        WorkflowRunner({}, max_concurrency=value)


def test_captures_missing_action_and_exception_as_failures() -> None:
    def broken(_step, _dependencies):
        raise RuntimeError("database unavailable")

    workflow = Workflow((Step("missing", "unknown"), Step("broken", "broken")))
    result = run(WorkflowRunner({"broken": broken}).run(workflow))
    assert [item.status for item in result.results] == [StepStatus.FAILED, StepStatus.FAILED]
    assert "unknown" in (result.by_id["missing"].error or "")
    assert "database unavailable" in (result.by_id["broken"].error or "")


def test_skips_failed_dependency_but_continues_independent_branch() -> None:
    called = []

    def action(step, _dependencies):
        called.append(step.id)
        if step.id == "fail":
            raise ValueError("boom")
        return step.id

    workflow = Workflow(
        (
            Step("fail", "run"),
            Step("independent", "run"),
            Step("blocked", "run", ("fail",)),
            Step("still-runs", "run", ("independent",)),
            Step("deep-blocked", "run", ("blocked",)),
        )
    )
    result = run(WorkflowRunner({"run": action}).run(workflow))
    assert result.by_id["fail"].status is StepStatus.FAILED
    assert result.by_id["blocked"].status is StepStatus.SKIPPED
    assert result.by_id["deep-blocked"].status is StepStatus.SKIPPED
    assert result.by_id["still-runs"].status is StepStatus.SUCCESS
    assert called == ["fail", "independent", "still-runs"]


def test_fail_fast_skips_all_later_layers() -> None:
    called = []

    def action(step, _dependencies):
        called.append(step.id)
        if step.id == "fail":
            raise ValueError("boom")
        return step.id

    workflow = Workflow(
        (
            Step("fail", "run"),
            Step("same-layer", "run"),
            Step("dependent", "run", ("same-layer",)),
            Step("later-independent", "run", ("same-layer",)),
        )
    )
    result = run(WorkflowRunner({"run": action}, fail_fast=True).run(workflow))
    assert called == ["fail", "same-layer"]
    assert result.by_id["dependent"].status is StepStatus.SKIPPED
    assert result.by_id["later-independent"].status is StepStatus.SKIPPED
    assert "fail_fast" in (result.by_id["later-independent"].error or "")


def test_preserves_original_result_order() -> None:
    workflow = Workflow(
        (
            Step("last-ready", "run", ("root",)),
            Step("root", "run"),
            Step("also-root", "run"),
        )
    )
    result = run(WorkflowRunner({"run": lambda step, _deps: step.id}).run(workflow))
    assert [item.step_id for item in result.results] == ["last-ready", "root", "also-root"]


def test_propagates_external_cancellation() -> None:
    async def cancelled(_step, _dependencies):
        raise asyncio.CancelledError

    workflow = Workflow((Step("cancel", "cancel"),))
    with pytest.raises(asyncio.CancelledError):
        run(WorkflowRunner({"cancel": cancelled}).run(workflow))
