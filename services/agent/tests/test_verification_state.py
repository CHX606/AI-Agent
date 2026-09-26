import json

import pytest
from bit_agent.agent.result import ToolCallRecord
from bit_agent.agent.verification import (
    INDEPENDENT_ACCEPTANCE_REQUIRED_MESSAGE,
    VERIFICATION_REQUIRED_MESSAGE,
    VerificationState,
    check_paths_cover_changes,
)
from bit_agent.memory import WorkingMemory
from bit_agent.tools.models import ToolError, ToolMetadata, ToolStatus


def record(
    name: str,
    *,
    ok: bool = True,
    arguments: dict | None = None,
    output: object = None,
    affected: list[str] | None = None,
) -> ToolCallRecord:
    return ToolCallRecord(
        round=1,
        tool_call_id="call",
        tool_name=name,
        raw_arguments=json.dumps(arguments or {}),
        arguments=arguments,
        status=ToolStatus.SUCCESS if ok else ToolStatus.ERROR,
        output=output,
        error=None if ok else ToolError(code="FAILED", message="failed", retryable=True),
        metadata=ToolMetadata(duration_ms=0, affected_paths=affected or []),
    )


def patch(state: VerificationState, *paths: str) -> None:
    state.observe("apply_patch", record("apply_patch", affected=list(paths)))


def lint(paths: list[str], *, ok: bool = True) -> ToolCallRecord:
    return record("run_checks", ok=ok, arguments={"check": "lint", "paths": paths})


@pytest.mark.parametrize(
    ("paths", "expected"),
    [
        (["src/a.py", "src/b.py"], True),
        (["src"], True),
        (["."], True),
        ([""], True),
        (["src\\"], True),
        (["src/a.py"], False),
        (["sr"], False),
        ("src", False),
        ([1], False),
    ],
)
def test_check_paths_cover_changes(paths: object, expected: bool) -> None:
    assert check_paths_cover_changes(paths, {"src/a.py", "src\\b.py"}) is expected


def test_fresh_state_allows_finishing() -> None:
    state = VerificationState()
    assert not state.has_unverified_changes
    assert state.acceptance_status == "NOT_RUN"


def test_patch_then_tests_and_covering_lint_completes_verification() -> None:
    state = VerificationState()
    patch(state, "src/a.py")
    assert state.has_unverified_changes

    state.observe("run_tests", record("run_tests"))
    assert state.tests_passed and state.has_unverified_changes

    state.observe("run_checks", lint(["src"]))
    assert state.quality_checks_passed
    assert not state.has_unverified_changes


def test_lint_before_tests_also_completes_verification() -> None:
    state = VerificationState()
    patch(state, "a.py")
    state.observe("run_checks", lint(["a.py"]))
    assert state.has_unverified_changes
    state.observe("run_tests", record("run_tests"))
    assert not state.has_unverified_changes


def test_lint_not_covering_every_change_does_not_count() -> None:
    state = VerificationState()
    patch(state, "a.py", "b.py")
    state.observe("run_tests", record("run_tests"))
    state.observe("run_checks", lint(["a.py"]))
    assert not state.quality_checks_passed
    assert state.has_unverified_changes


def test_non_lint_checks_are_ignored() -> None:
    state = VerificationState()
    patch(state, "a.py")
    state.observe("run_tests", record("run_tests"))
    state.observe(
        "run_checks", record("run_checks", arguments={"check": "typecheck", "paths": ["."]})
    )
    assert not state.quality_checks_passed
    assert state.has_unverified_changes


def test_new_patch_invalidates_earlier_verification() -> None:
    state = VerificationState()
    patch(state, "a.py")
    state.observe("run_tests", record("run_tests"))
    state.observe("run_checks", lint(["."]))
    assert not state.has_unverified_changes

    patch(state, "b.py")
    assert state.has_unverified_changes
    assert not state.tests_passed and not state.quality_checks_passed
    assert state.changed_files == {"a.py", "b.py"}


def test_failed_patch_changes_nothing() -> None:
    state = VerificationState()
    state.observe("apply_patch", record("apply_patch", ok=False, affected=["a.py"]))
    assert not state.has_unverified_changes
    assert state.changed_files == set()


def test_failed_tests_keep_changes_unverified() -> None:
    state = VerificationState()
    patch(state, "a.py")
    state.observe("run_checks", lint(["."]))
    state.observe("run_tests", record("run_tests", ok=False))
    assert not state.tests_passed
    assert state.has_unverified_changes


def test_failed_lint_resets_quality_flag() -> None:
    state = VerificationState()
    patch(state, "a.py")
    state.observe("run_checks", lint(["."]))
    state.observe("run_checks", lint(["."], ok=False))
    assert not state.quality_checks_passed
    assert state.has_unverified_changes


def test_checks_without_changes_never_block_finishing() -> None:
    state = VerificationState()
    state.observe("run_tests", record("run_tests", ok=False))
    state.observe("run_checks", lint(["."], ok=False))
    assert not state.has_unverified_changes


def test_independent_mode_requires_verify_task_pass() -> None:
    state = VerificationState(require_independent_acceptance=True)
    patch(state, "a.py")

    state.observe("verify_project", record("verify_project"))
    assert state.tests_passed and state.quality_checks_passed
    assert state.has_unverified_changes

    state.observe("verify_task", record("verify_task", output={"verdict": "PASSED"}))
    assert state.acceptance_status == "PASSED"
    assert not state.has_unverified_changes


def test_independent_mode_ignores_plain_tests_and_lint() -> None:
    state = VerificationState(require_independent_acceptance=True)
    patch(state, "a.py")
    state.observe("run_tests", record("run_tests"))
    state.observe("run_checks", lint(["."]))
    assert state.has_unverified_changes


@pytest.mark.parametrize(
    ("ok", "output", "status"),
    [
        (True, {"verdict": "FAILED"}, "FAILED"),
        (False, {"verdict": "FAILED"}, "FAILED"),
        (False, {"verdict": "PASSED"}, "NOT_VERIFIED"),
        (True, {"verdict": "UNKNOWN"}, "NOT_VERIFIED"),
        (True, "not a dict", "NOT_VERIFIED"),
    ],
)
def test_verify_task_non_pass_outcomes(ok: bool, output: object, status: str) -> None:
    state = VerificationState(require_independent_acceptance=True)
    patch(state, "a.py")
    state.observe("verify_project", record("verify_project"))
    state.observe("verify_task", record("verify_task", ok=ok, output=output))
    assert state.acceptance_status == status
    assert state.has_unverified_changes


def test_verify_task_pass_without_basic_checks_is_not_enough() -> None:
    state = VerificationState(require_independent_acceptance=True)
    patch(state, "a.py")
    state.observe("verify_task", record("verify_task", output={"verdict": "PASSED"}))
    assert state.acceptance_status == "PASSED"
    assert state.has_unverified_changes


def test_verify_project_pass_completes_plain_mode() -> None:
    state = VerificationState()
    patch(state, "a.py")
    state.observe("verify_project", record("verify_project"))
    assert not state.has_unverified_changes


def test_verify_project_resets_previous_acceptance() -> None:
    state = VerificationState(require_independent_acceptance=True)
    patch(state, "a.py")
    state.observe("verify_project", record("verify_project"))
    state.observe("verify_task", record("verify_task", output={"verdict": "PASSED"}))
    state.observe("verify_project", record("verify_project", ok=False))
    assert state.acceptance_status == "NOT_RUN"
    assert state.has_unverified_changes


def test_requirement_change_reopens_acceptance_only_in_independent_mode() -> None:
    plain = VerificationState()
    patch(plain, "a.py")
    plain.observe("verify_project", record("verify_project"))
    plain.requirements_changed()
    assert not plain.has_unverified_changes

    independent = VerificationState(require_independent_acceptance=True)
    patch(independent, "a.py")
    independent.observe("verify_project", record("verify_project"))
    independent.observe("verify_task", record("verify_task", output={"verdict": "PASSED"}))
    independent.requirements_changed()
    assert independent.acceptance_status == "NOT_RUN"
    assert independent.has_unverified_changes


def test_requirement_change_without_changes_is_noop() -> None:
    state = VerificationState(require_independent_acceptance=True)
    state.requirements_changed()
    assert not state.has_unverified_changes


def test_reminder_matches_mode() -> None:
    assert VerificationState().reminder == VERIFICATION_REQUIRED_MESSAGE
    assert (
        VerificationState(require_independent_acceptance=True).reminder
        == INDEPENDENT_ACCEPTANCE_REQUIRED_MESSAGE
    )


def test_save_and_restore_round_trip() -> None:
    state = VerificationState()
    patch(state, "b.py", "a.py")
    state.observe("run_tests", record("run_tests"))
    memory = WorkingMemory(objective="fix", thread_id="t")
    state.save_to(memory)
    assert memory.has_unverified_changes
    assert memory.verification_paths == ["a.py", "b.py"]
    assert not memory.basic_checks_passed

    restored = VerificationState()
    restored.restore(memory, patch_interrupted=False)
    assert restored.has_unverified_changes
    assert restored.changed_files == {"a.py", "b.py"}


def test_verified_state_saves_no_paths() -> None:
    state = VerificationState()
    patch(state, "a.py")
    state.observe("verify_project", record("verify_project"))
    memory = WorkingMemory(objective="fix", thread_id="t")
    state.save_to(memory)
    assert not memory.has_unverified_changes
    assert memory.verification_paths == []
    assert memory.basic_checks_passed


def test_interrupted_patch_marks_whole_workspace_unverified() -> None:
    state = VerificationState()
    state.restore(WorkingMemory(objective="fix", thread_id="t"), patch_interrupted=True)
    assert state.has_unverified_changes
    assert state.changed_files == {"."}
    state.observe("run_tests", record("run_tests"))
    state.observe("run_checks", lint(["src"]))
    assert state.has_unverified_changes
    state.observe("run_checks", lint(["."]))
    assert not state.has_unverified_changes
