from pathlib import Path

import pytest
from bit_agent.tools.context import ToolContext


def test_context_resolves_trusted_workspace(tmp_path: Path) -> None:
    context = ToolContext(tmp_path, "call_1")
    assert context.workspace_root == tmp_path.resolve()


@pytest.mark.parametrize(
    "field",
    [
        "timeout_seconds",
        "max_output_bytes",
        "max_results",
        "max_depth",
        "max_read_lines",
        "max_patch_bytes",
        "max_patch_files",
    ],
)
def test_context_rejects_non_positive_limits(tmp_path: Path, field: str) -> None:
    with pytest.raises(ValueError):
        ToolContext(tmp_path, "call_1", **{field: 0})


def test_context_rejects_blank_tool_call_id(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        ToolContext(tmp_path, "   ")


def test_context_rejects_blank_task_id(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        ToolContext(tmp_path, "call_1", task_id="   ")
