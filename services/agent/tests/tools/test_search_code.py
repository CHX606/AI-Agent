from pathlib import Path

import pytest
from bit_agent.tools import search_code
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolStatus


@pytest.mark.asyncio
async def test_searches_code_and_returns_locations(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text("needle = 1\n", encoding="utf-8")
    result = await search_code(ToolContext(tmp_path, "call_1"), "needle", glob="*.py")
    assert result.status is ToolStatus.SUCCESS
    assert "main.py:1:1:needle = 1" in result.output


@pytest.mark.asyncio
async def test_no_matches_is_success(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text("hello", encoding="utf-8")
    result = await search_code(ToolContext(tmp_path, "call_1"), "absent")
    assert result.status is ToolStatus.SUCCESS
    assert result.output == ""


@pytest.mark.asyncio
async def test_missing_path_is_error(tmp_path: Path) -> None:
    result = await search_code(ToolContext(tmp_path, "call_1"), "x", "missing")
    assert result.error and result.error.code == "FILE_NOT_FOUND"


@pytest.mark.asyncio
async def test_empty_query_is_error(tmp_path: Path) -> None:
    result = await search_code(ToolContext(tmp_path, "call_1"), "")
    assert result.error and result.error.code == "INVALID_ARGUMENT"


@pytest.mark.asyncio
async def test_unsafe_path_is_rejected(tmp_path: Path) -> None:
    result = await search_code(ToolContext(tmp_path, "call_1"), "x", "../outside")
    assert result.status is ToolStatus.REJECTED


@pytest.mark.asyncio
async def test_result_limit_is_reported(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text("needle\nneedle\nneedle\n", encoding="utf-8")
    result = await search_code(ToolContext(tmp_path, "call_1"), "needle", max_results=2)
    assert result.error and result.error.code == "RESULT_LIMIT_EXCEEDED"
    assert result.metadata.truncated
    assert len(result.output.splitlines()) == 2
    assert "搜索结果不完整" in result.error.message
    assert "2 条" in result.error.message
    assert "query" in result.error.message and "path" in result.error.message
    assert "glob" in result.error.message and "max_results" in result.error.message
    assert "原样重复搜索不会自动返回下一批" in result.error.message


@pytest.mark.asyncio
async def test_glob_filters_files_and_max_results_can_be_increased(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text("needle\n" * 60, encoding="utf-8")
    (tmp_path / "notes.txt").write_text("needle_should_be_excluded\n", encoding="utf-8")
    result = await search_code(
        ToolContext(tmp_path, "filtered"), "needle", glob="*.py", max_results=100
    )
    assert result.status is ToolStatus.SUCCESS
    assert len(result.output.splitlines()) == 60
    assert "notes.txt" not in result.output
    assert result.metadata.truncated is False


@pytest.mark.asyncio
async def test_byte_limit_hint_does_not_suggest_raising_result_limit(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text("needle" + "x" * 100, encoding="utf-8")
    result = await search_code(ToolContext(tmp_path, "bytes", max_output_bytes=20), "needle")
    assert result.error and result.error.code == "OUTPUT_LIMIT_EXCEEDED"
    assert result.metadata.truncated
    assert len(result.output.encode("utf-8")) <= 20
    assert "20 字节" in result.error.message
    assert "单纯提高 max_results 不能突破" in result.error.message
    assert "也可适当提高" not in result.error.message


@pytest.mark.asyncio
@pytest.mark.parametrize("max_results", [0, 201, True, 1.5, None, "50"])
async def test_invalid_max_results_is_rejected(tmp_path: Path, max_results: object) -> None:
    result = await search_code(ToolContext(tmp_path, "invalid"), "needle", max_results=max_results)
    assert result.error and result.error.code == "INVALID_ARGUMENT"


@pytest.mark.asyncio
@pytest.mark.parametrize("glob", ["", 123, "*.py\x00"])
async def test_invalid_glob_is_rejected(tmp_path: Path, glob: object) -> None:
    result = await search_code(ToolContext(tmp_path, "invalid"), "needle", glob=glob)
    assert result.error and result.error.code == "INVALID_ARGUMENT"


@pytest.mark.asyncio
@pytest.mark.parametrize("glob", ["*", ".env*", "*.pem", "*.py"])
async def test_glob_cannot_include_protected_files(tmp_path: Path, glob: str) -> None:
    (tmp_path / ".env.local").write_text("needle_secret\n", encoding="utf-8")
    (tmp_path / "test.PEM").write_text("needle_secret\n", encoding="utf-8")
    (tmp_path / "id_ed25519").write_text("needle_secret\n", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "hidden.py").write_text("needle_secret\n", encoding="utf-8")
    (tmp_path / "main.py").write_text("needle_public\n", encoding="utf-8")
    result = await search_code(ToolContext(tmp_path, "protected"), "needle", glob=glob)
    assert result.status is ToolStatus.SUCCESS
    assert "needle_secret" not in result.output
    if glob in {"*", "*.py"}:
        assert "needle_public" in result.output
