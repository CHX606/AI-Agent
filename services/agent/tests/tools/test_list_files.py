from pathlib import Path

import pytest
from bit_agent.tools import list_files
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolStatus


@pytest.mark.asyncio
async def test_lists_files_with_depth_and_ignores_protected_dirs(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("pass", encoding="utf-8")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_text("secret", encoding="utf-8")
    result = await list_files(ToolContext(tmp_path, "call_1"), max_depth=1)
    assert result.status is ToolStatus.SUCCESS
    assert result.output == "src/\nsrc/main.py"


@pytest.mark.asyncio
async def test_missing_directory_is_error(tmp_path: Path) -> None:
    result = await list_files(ToolContext(tmp_path, "call_1"), "missing")
    assert result.error and result.error.code == "FILE_NOT_FOUND"


@pytest.mark.asyncio
async def test_invalid_depth_is_error(tmp_path: Path) -> None:
    result = await list_files(ToolContext(tmp_path, "call_1", max_depth=2), max_depth=3)
    assert result.error and result.error.code == "INVALID_ARGUMENT"


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["../secret", "C:\\Users\\secret", ".git", ".env"])
async def test_unsafe_path_is_rejected(tmp_path: Path, path: str) -> None:
    result = await list_files(ToolContext(tmp_path, "call_1"), path)
    assert result.status is ToolStatus.REJECTED


@pytest.mark.asyncio
async def test_result_limit_is_reported(tmp_path: Path) -> None:
    for index in range(3):
        (tmp_path / f"file{index}.txt").write_text("x", encoding="utf-8")
    result = await list_files(ToolContext(tmp_path, "call_1", max_results=2))
    assert result.error and result.error.code == "RESULT_LIMIT_EXCEEDED"
    assert result.metadata.truncated


@pytest.mark.asyncio
async def test_output_byte_limit_is_reported(tmp_path: Path) -> None:
    (tmp_path / "very_long_filename.txt").write_text("x", encoding="utf-8")

    result = await list_files(
        ToolContext(
            tmp_path,
            "call_1",
            max_output_bytes=10,
        )
    )

    assert result.error
    assert result.error.code == "OUTPUT_LIMIT_EXCEEDED"
    assert result.metadata.truncated


@pytest.mark.asyncio
async def test_does_not_follow_symlink_outside_workspace(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text(
        "secret",
        encoding="utf-8",
    )

    link = workspace / "linked"
    link.symlink_to(outside, target_is_directory=True)

    result = await list_files(
        ToolContext(workspace, "call_1"),
        max_depth=1,
    )

    assert result.status is ToolStatus.SUCCESS
    assert isinstance(result.output, str)
    assert "secret.txt" not in result.output
