from pathlib import Path

import pytest
from bit_agent.context.snippets import TRUNCATION_MARKER, extract_snippet


def write_numbered_file(path: Path, line_count: int) -> None:
    path.write_text(
        "\n".join(f"content {line_number}" for line_number in range(1, line_count + 1)),
        encoding="utf-8",
    )


def test_extract_snippet_includes_context_and_line_numbers(tmp_path: Path) -> None:
    source_file = tmp_path / "pricing.py"
    write_numbered_file(source_file, 10)

    snippet = extract_snippet(
        source_file,
        start_line=4,
        end_line=5,
        context_lines=2,
    )

    assert snippet == "\n".join(
        [
            "     2 | content 2",
            "     3 | content 3",
            "     4 | content 4",
            "     5 | content 5",
            "     6 | content 6",
            "     7 | content 7",
        ]
    )


def test_extract_snippet_clamps_context_to_file_boundaries(tmp_path: Path) -> None:
    source_file = tmp_path / "pricing.py"
    write_numbered_file(source_file, 5)

    snippet = extract_snippet(source_file, start_line=1, end_line=2)

    assert snippet.splitlines() == [
        "     1 | content 1",
        "     2 | content 2",
        "     3 | content 3",
        "     4 | content 4",
        "     5 | content 5",
    ]


def test_extract_snippet_truncates_context_without_losing_target(tmp_path: Path) -> None:
    source_file = tmp_path / "pricing.py"
    write_numbered_file(source_file, 20)

    snippet = extract_snippet(
        source_file,
        start_line=10,
        end_line=11,
        context_lines=8,
        max_lines=6,
    )

    assert snippet.splitlines() == [
        TRUNCATION_MARKER,
        "     8 | content 8",
        "     9 | content 9",
        "    10 | content 10",
        "    11 | content 11",
        "    12 | content 12",
        "    13 | content 13",
        TRUNCATION_MARKER,
    ]


def test_extract_snippet_truncates_long_definition_at_head_and_tail(tmp_path: Path) -> None:
    source_file = tmp_path / "pricing.py"
    write_numbered_file(source_file, 20)

    snippet = extract_snippet(
        source_file,
        start_line=3,
        end_line=18,
        context_lines=0,
        max_lines=4,
    )

    assert snippet.splitlines() == [
        "     3 | content 3",
        "     4 | content 4",
        TRUNCATION_MARKER,
        "    17 | content 17",
        "    18 | content 18",
    ]


@pytest.mark.parametrize(
    ("start_line", "end_line", "context_lines", "max_lines"),
    [
        (0, 1, 3, 80),
        (3, 2, 3, 80),
        (1, 1, -1, 80),
        (1, 1, 3, 0),
    ],
)
def test_extract_snippet_rejects_invalid_ranges(
    tmp_path: Path,
    start_line: int,
    end_line: int,
    context_lines: int,
    max_lines: int,
) -> None:
    source_file = tmp_path / "pricing.py"
    write_numbered_file(source_file, 5)

    with pytest.raises(ValueError):
        extract_snippet(
            source_file,
            start_line,
            end_line,
            context_lines,
            max_lines=max_lines,
        )


def test_extract_snippet_rejects_start_after_end_of_file(tmp_path: Path) -> None:
    source_file = tmp_path / "pricing.py"
    write_numbered_file(source_file, 5)

    with pytest.raises(ValueError, match="超出文件行数"):
        extract_snippet(source_file, start_line=6, end_line=6)
