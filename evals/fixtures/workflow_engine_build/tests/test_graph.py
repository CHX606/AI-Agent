import pytest

from workflow_engine import (
    DuplicateDependencyError,
    DuplicateStepError,
    EmptyWorkflowError,
    InvalidStepError,
    SelfDependencyError,
    Step,
    UnknownDependencyError,
    Workflow,
    WorkflowCycleError,
    topological_layers,
    transitive_dependencies,
    validate_workflow,
)


def test_rejects_empty_workflow() -> None:
    with pytest.raises(EmptyWorkflowError):
        validate_workflow(Workflow(steps=()))


@pytest.mark.parametrize("step", [Step("", "run"), Step("  ", "run"), Step("a", " ")])
def test_rejects_blank_step_fields(step: Step) -> None:
    with pytest.raises(InvalidStepError):
        validate_workflow(Workflow(steps=(step,)))


def test_rejects_duplicate_step_ids() -> None:
    workflow = Workflow((Step("same", "one"), Step("same", "two")))
    with pytest.raises(DuplicateStepError):
        validate_workflow(workflow)


def test_rejects_unknown_duplicate_and_self_dependencies() -> None:
    with pytest.raises(UnknownDependencyError):
        validate_workflow(Workflow((Step("a", "run", ("missing",)),)))
    with pytest.raises(DuplicateDependencyError):
        validate_workflow(Workflow((Step("a", "run"), Step("b", "run", ("a", "a")))))
    with pytest.raises(SelfDependencyError):
        validate_workflow(Workflow((Step("a", "run", ("a",)),)))


def test_rejects_direct_and_indirect_cycles() -> None:
    with pytest.raises(WorkflowCycleError):
        validate_workflow(Workflow((Step("a", "run", ("b",)), Step("b", "run", ("a",)))))
    with pytest.raises(WorkflowCycleError):
        validate_workflow(
            Workflow(
                (
                    Step("a", "run", ("c",)),
                    Step("b", "run", ("a",)),
                    Step("c", "run", ("b",)),
                )
            )
        )


def test_builds_stable_topological_layers() -> None:
    workflow = Workflow(
        (
            Step("fetch", "run"),
            Step("lint", "run"),
            Step("compile", "run", ("fetch",)),
            Step("unit", "run", ("compile",)),
            Step("package", "run", ("compile", "lint")),
            Step("publish", "run", ("unit", "package")),
        )
    )
    assert topological_layers(workflow) == (
        ("fetch", "lint"),
        ("compile",),
        ("unit", "package"),
        ("publish",),
    )


def test_returns_transitive_dependencies_in_original_order() -> None:
    workflow = Workflow(
        (
            Step("source", "run"),
            Step("lint", "run"),
            Step("build", "run", ("source",)),
            Step("test", "run", ("build",)),
            Step("deploy", "run", ("test", "lint")),
        )
    )
    assert transitive_dependencies(workflow, "deploy") == ("source", "lint", "build", "test")
    with pytest.raises(KeyError):
        transitive_dependencies(workflow, "unknown")
