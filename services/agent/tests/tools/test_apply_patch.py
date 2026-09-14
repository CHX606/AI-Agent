from pathlib import Path

import pytest
from bit_agent.tools import apply_patch
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolStatus


def make_patch(path: str, before: str, after: str) -> str:
    return (
        f"diff --git a/{path} b/{path}\n"
        f"--- a/{path}\n"
        f"+++ b/{path}\n"
        "@@ -1 +1 @@\n"
        f"-{before}\n"
        f"+{after}\n"
    )


def make_begin_update(path: str, before: str, after: str) -> str:
    return f"*** Begin Patch\n*** Update File: {path}\n@@\n-{before}\n+{after}\n*** End Patch\n"


@pytest.mark.asyncio
async def test_applies_patch_to_one_file(tmp_path: Path) -> None:
    target = tmp_path / "calculator.py"
    target.write_text("return left - right\n", encoding="utf-8")

    outcome = await apply_patch(
        ToolContext(tmp_path, "call_1"),
        make_patch("calculator.py", "return left - right", "return left + right"),
    )

    assert outcome.status is ToolStatus.SUCCESS
    assert outcome.output == "Patch applied"
    assert outcome.metadata.affected_paths == ["calculator.py"]
    assert target.read_text(encoding="utf-8") == "return left + right\n"


@pytest.mark.asyncio
async def test_rejects_malformed_patch(tmp_path: Path) -> None:
    outcome = await apply_patch(ToolContext(tmp_path, "call_1"), "not a patch")

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "PATCH_REJECTED"


@pytest.mark.asyncio
async def test_rejects_content_mismatch_without_modifying_file(tmp_path: Path) -> None:
    target = tmp_path / "calculator.py"
    target.write_text("actual content\n", encoding="utf-8")

    outcome = await apply_patch(
        ToolContext(tmp_path, "call_1"),
        make_patch("calculator.py", "different content", "replacement"),
    )

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "PATCH_REJECTED"
    assert target.read_text(encoding="utf-8") == "actual content\n"


@pytest.mark.asyncio
async def test_applies_patch_to_multiple_files(tmp_path: Path) -> None:
    first = tmp_path / "first.py"
    second = tmp_path / "second.py"
    first.write_text("old first\n", encoding="utf-8")
    second.write_text("old second\n", encoding="utf-8")
    patch = make_patch("first.py", "old first", "new first") + make_patch(
        "second.py", "old second", "new second"
    )

    outcome = await apply_patch(ToolContext(tmp_path, "call_1"), patch)

    assert outcome.status is ToolStatus.SUCCESS
    assert outcome.metadata.affected_paths == ["first.py", "second.py"]
    assert first.read_text(encoding="utf-8") == "new first\n"
    assert second.read_text(encoding="utf-8") == "new second\n"


@pytest.mark.asyncio
async def test_rejects_protected_file(tmp_path: Path) -> None:
    target = tmp_path / ".env"
    target.write_text("TOKEN=old\n", encoding="utf-8")

    outcome = await apply_patch(
        ToolContext(tmp_path, "call_1"),
        make_patch(".env", "TOKEN=old", "TOKEN=new"),
    )

    assert outcome.status is ToolStatus.REJECTED
    assert outcome.error and outcome.error.code == "PROTECTED_PATH"
    assert target.read_text(encoding="utf-8") == "TOKEN=old\n"


@pytest.mark.asyncio
async def test_rejects_path_outside_workspace(tmp_path: Path) -> None:
    outcome = await apply_patch(
        ToolContext(tmp_path, "call_1"),
        make_patch("../secret.txt", "old", "new"),
    )

    assert outcome.status is ToolStatus.REJECTED
    assert outcome.error and outcome.error.code == "PATH_OUTSIDE_WORKSPACE"


@pytest.mark.asyncio
async def test_rejects_oversized_patch(tmp_path: Path) -> None:
    patch = make_patch("file.py", "old", "new")
    context = ToolContext(tmp_path, "call_1", max_patch_bytes=len(patch.encode()) - 1)

    outcome = await apply_patch(context, patch)

    assert outcome.status is ToolStatus.REJECTED
    assert outcome.error and outcome.error.code == "PATCH_TOO_LARGE"


@pytest.mark.asyncio
async def test_rejects_too_many_files(tmp_path: Path) -> None:
    first = tmp_path / "first.py"
    second = tmp_path / "second.py"
    first.write_text("old first\n", encoding="utf-8")
    second.write_text("old second\n", encoding="utf-8")
    patch = make_patch("first.py", "old first", "new first") + make_patch(
        "second.py", "old second", "new second"
    )

    outcome = await apply_patch(
        ToolContext(tmp_path, "call_1", max_patch_files=1),
        patch,
    )

    assert outcome.status is ToolStatus.REJECTED
    assert outcome.error and outcome.error.code == "TOO_MANY_FILES"
    assert first.read_text(encoding="utf-8") == "old first\n"
    assert second.read_text(encoding="utf-8") == "old second\n"


@pytest.mark.asyncio
async def test_failed_multi_file_patch_leaves_every_file_unchanged(tmp_path: Path) -> None:
    first = tmp_path / "first.py"
    second = tmp_path / "second.py"
    first.write_text("old first\n", encoding="utf-8")
    second.write_text("actual second\n", encoding="utf-8")
    patch = make_patch("first.py", "old first", "new first") + make_patch(
        "second.py", "wrong second", "new second"
    )

    outcome = await apply_patch(ToolContext(tmp_path, "call_1"), patch)

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "PATCH_REJECTED"
    assert first.read_text(encoding="utf-8") == "old first\n"
    assert second.read_text(encoding="utf-8") == "actual second\n"


@pytest.mark.asyncio
async def test_converts_and_applies_begin_patch_update(tmp_path: Path) -> None:
    target = tmp_path / "calculator.py"
    target.write_text(
        "def add(left, right):\n    return left - right\n",
        encoding="utf-8",
    )
    patch = (
        "*** Begin Patch\n"
        "*** Update File: calculator.py\n"
        "@@\n"
        " def add(left, right):\n"
        "-    return left - right\n"
        "+    return left + right\n"
        "*** End Patch\n"
    )

    outcome = await apply_patch(ToolContext(tmp_path, "call_1"), patch)

    assert outcome.status is ToolStatus.SUCCESS
    assert outcome.metadata.affected_paths == ["calculator.py"]
    assert target.read_text(encoding="utf-8") == (
        "def add(left, right):\n    return left + right\n"
    )


@pytest.mark.asyncio
async def test_converts_and_applies_begin_patch_add(tmp_path: Path) -> None:
    patch = (
        "*** Begin Patch\n*** Add File: created.py\n+def answer():\n+    return 42\n*** End Patch\n"
    )

    outcome = await apply_patch(ToolContext(tmp_path, "call_1"), patch)

    assert outcome.status is ToolStatus.SUCCESS
    assert outcome.metadata.affected_paths == ["created.py"]
    assert (tmp_path / "created.py").read_text(encoding="utf-8") == (
        "def answer():\n    return 42\n"
    )


@pytest.mark.asyncio
async def test_converts_and_applies_begin_patch_delete(tmp_path: Path) -> None:
    target = tmp_path / "obsolete.py"
    target.write_text("obsolete = True\n", encoding="utf-8")
    patch = "*** Begin Patch\n*** Delete File: obsolete.py\n*** End Patch\n"

    outcome = await apply_patch(ToolContext(tmp_path, "call_1"), patch)

    assert outcome.status is ToolStatus.SUCCESS
    assert outcome.metadata.affected_paths == ["obsolete.py"]
    assert not target.exists()


@pytest.mark.asyncio
async def test_begin_patch_applies_multiple_operations_atomically(tmp_path: Path) -> None:
    target = tmp_path / "calculator.py"
    target.write_text("return left - right\n", encoding="utf-8")
    patch = (
        "*** Begin Patch\n"
        "*** Update File: calculator.py\n"
        "@@\n"
        "-return left - right\n"
        "+return left + right\n"
        "*** Add File: test_calculator.py\n"
        "+def test_add():\n"
        "+    assert 1 + 1 == 2\n"
        "*** End Patch\n"
    )

    outcome = await apply_patch(ToolContext(tmp_path, "call_1"), patch)

    assert outcome.status is ToolStatus.SUCCESS
    assert outcome.metadata.affected_paths == ["calculator.py", "test_calculator.py"]
    assert target.read_text(encoding="utf-8") == "return left + right\n"
    assert (tmp_path / "test_calculator.py").exists()


@pytest.mark.asyncio
async def test_begin_patch_rejects_ambiguous_update_without_changes(
    tmp_path: Path,
) -> None:
    target = tmp_path / "repeated.py"
    original = "value = old\nseparator = True\nvalue = old\n"
    target.write_text(original, encoding="utf-8")

    outcome = await apply_patch(
        ToolContext(tmp_path, "call_1"),
        make_begin_update("repeated.py", "value = old", "value = new"),
    )

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "PATCH_REJECTED"
    assert "匹配到多处" in outcome.error.message
    assert target.read_text(encoding="utf-8") == original


@pytest.mark.asyncio
async def test_begin_patch_rejects_context_mismatch_without_changes(
    tmp_path: Path,
) -> None:
    target = tmp_path / "calculator.py"
    target.write_text("actual content\n", encoding="utf-8")

    outcome = await apply_patch(
        ToolContext(tmp_path, "call_1"),
        make_begin_update("calculator.py", "different content", "replacement"),
    )

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "PATCH_REJECTED"
    assert target.read_text(encoding="utf-8") == "actual content\n"


@pytest.mark.asyncio
async def test_begin_patch_rejects_protected_path(tmp_path: Path) -> None:
    target = tmp_path / ".env"
    target.write_text("TOKEN=old\n", encoding="utf-8")

    outcome = await apply_patch(
        ToolContext(tmp_path, "call_1"),
        make_begin_update(".env", "TOKEN=old", "TOKEN=new"),
    )

    assert outcome.status is ToolStatus.REJECTED
    assert outcome.error and outcome.error.code == "PROTECTED_PATH"
    assert target.read_text(encoding="utf-8") == "TOKEN=old\n"


@pytest.mark.asyncio
async def test_begin_patch_rejects_path_outside_workspace(tmp_path: Path) -> None:
    patch = "*** Begin Patch\n*** Add File: ../secret.py\n+secret = True\n*** End Patch\n"

    outcome = await apply_patch(ToolContext(tmp_path, "call_1"), patch)

    assert outcome.status is ToolStatus.REJECTED
    assert outcome.error and outcome.error.code == "PATH_OUTSIDE_WORKSPACE"


@pytest.mark.asyncio
async def test_begin_patch_rejects_unknown_directive(tmp_path: Path) -> None:
    outcome = await apply_patch(
        ToolContext(tmp_path, "call_1"),
        "*** Begin Patch\n*** Move File: old.py\n*** End Patch\n",
    )

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "PATCH_REJECTED"


@pytest.mark.asyncio
async def test_begin_patch_normalizes_windows_separators_and_quotes_spaces(
    tmp_path: Path,
) -> None:
    folder = tmp_path / "nested folder"
    folder.mkdir()
    patch = (
        "*** Begin Patch\n*** Add File: nested folder\\created.py\n+answer = 42\n*** End Patch\n"
    )

    outcome = await apply_patch(ToolContext(tmp_path, "call_1"), patch)

    assert outcome.status is ToolStatus.SUCCESS
    assert outcome.metadata.affected_paths == ["nested folder/created.py"]
    assert (folder / "created.py").read_text(encoding="utf-8") == "answer = 42\n"


@pytest.mark.asyncio
async def test_failed_begin_patch_multi_file_update_is_atomic(tmp_path: Path) -> None:
    first = tmp_path / "first.py"
    second = tmp_path / "second.py"
    first.write_text("first = 'old'\n", encoding="utf-8")
    second.write_text("second = 'actual'\n", encoding="utf-8")
    patch = (
        "*** Begin Patch\n"
        "*** Update File: first.py\n"
        "@@\n"
        "-first = 'old'\n"
        "+first = 'new'\n"
        "*** Update File: second.py\n"
        "@@\n"
        "-second = 'wrong'\n"
        "+second = 'new'\n"
        "*** End Patch\n"
    )

    outcome = await apply_patch(ToolContext(tmp_path, "call_1"), patch)

    assert outcome.status is ToolStatus.ERROR
    assert outcome.error and outcome.error.code == "PATCH_REJECTED"
    assert first.read_text(encoding="utf-8") == "first = 'old'\n"
    assert second.read_text(encoding="utf-8") == "second = 'actual'\n"
