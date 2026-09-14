from pathlib import Path

import pytest
from bit_agent.tools import read_file
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolStatus


@pytest.mark.asyncio
async def test_reads_selected_lines_with_numbers(tmp_path: Path) -> None:
    (tmp_path / "hello.py").write_text("one\ntwo\nthree\n", encoding="utf-8")
    result = await read_file(ToolContext(tmp_path, "call_1"), "hello.py", start_line=2, end_line=3)
    assert result.status is ToolStatus.SUCCESS
    assert result.output == "     2 | two\n     3 | three"
    assert result.metadata.affected_paths == ["hello.py"]


@pytest.mark.asyncio
@pytest.mark.parametrize("start_line,end_line", [(0, 1), (2, 1), (800, 1300)])
async def test_line_range_guards_remain_enforced(
    tmp_path: Path, start_line: int, end_line: int
) -> None:
    result = await read_file(
        ToolContext(tmp_path, "range-error"), "large.py",
        start_line=start_line, end_line=end_line,
    )
    assert result.status is ToolStatus.ERROR
    assert result.error and result.error.code == "INVALID_ARGUMENT"


@pytest.mark.asyncio
async def test_missing_file_is_error(tmp_path: Path) -> None:
    result = await read_file(ToolContext(tmp_path, "call_1"), "missing.py")
    assert result.error and result.error.code == "FILE_NOT_FOUND"


@pytest.mark.asyncio
async def test_invalid_line_range_is_error(tmp_path: Path) -> None:
    result = await read_file(ToolContext(tmp_path, "call_1"), "x", start_line=0, end_line=2)
    assert result.error and result.error.code == "INVALID_ARGUMENT"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path", ["../../secret.txt", "C:\\Users\\secret.txt", ".git/config", ".env.local"]
)
async def test_unsafe_path_is_rejected(tmp_path: Path, path: str) -> None:
    result = await read_file(ToolContext(tmp_path, "call_1"), path)
    assert result.status is ToolStatus.REJECTED


@pytest.mark.asyncio
async def test_binary_file_is_error(tmp_path: Path) -> None:
    (tmp_path / "image.bin").write_bytes(b"hello\x00world")
    result = await read_file(ToolContext(tmp_path, "call_1"), "image.bin")
    assert result.error and result.error.code == "NOT_A_TEXT_FILE"


@pytest.mark.asyncio
async def test_output_limit_is_reported(tmp_path: Path) -> None:
    (tmp_path / "large.txt").write_text("x" * 100, encoding="utf-8")
    result = await read_file(ToolContext(tmp_path, "call_1", max_output_bytes=20), "large.txt")
    assert result.error and result.error.code == "OUTPUT_LIMIT_EXCEEDED"
    assert result.metadata.truncated
