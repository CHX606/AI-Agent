"""从已定位的源码行中提取小型、带行号的代码片段。"""

from pathlib import Path

DEFAULT_CONTEXT_LINES = 3
DEFAULT_MAX_LINES = 80
TRUNCATION_MARKER = "       | ... snippet truncated ..."


def _validate_arguments(
    path: Path,
    start_line: int,
    end_line: int,
    context_lines: int,
    max_lines: int,
) -> None:
    if not isinstance(path, Path):
        raise TypeError("path 必须是 Path 对象")

    integer_arguments = (start_line, end_line, context_lines, max_lines)
    if not all(
        isinstance(value, int) and not isinstance(value, bool) for value in integer_arguments
    ):
        raise TypeError("行号和行数限制必须是整数")

    if start_line < 1 or end_line < start_line:
        raise ValueError("行号范围无效")
    if context_lines < 0:
        raise ValueError("context_lines 不能小于 0")
    if max_lines < 1:
        raise ValueError("max_lines 必须大于 0")


def _render_lines(lines: list[str], line_numbers: list[int | None]) -> str:
    rendered: list[str] = []
    for line_number in line_numbers:
        if line_number is None:
            rendered.append(TRUNCATION_MARKER)
        else:
            rendered.append(f"{line_number:>6} | {lines[line_number - 1]}")
    return "\n".join(rendered)


def _select_line_numbers(
    first_line: int,
    start_line: int,
    end_line: int,
    last_line: int,
    max_lines: int,
) -> list[int | None]:
    total_lines = last_line - first_line + 1
    if total_lines <= max_lines:
        return list(range(first_line, last_line + 1))

    target_lines = end_line - start_line + 1
    if target_lines > max_lines:
        head_count = (max_lines + 1) // 2
        tail_count = max_lines - head_count
        selected: list[int | None] = list(range(start_line, start_line + head_count))
        selected.append(None)
        if tail_count:
            selected.extend(range(end_line - tail_count + 1, end_line + 1))
        return selected

    remaining = max_lines - target_lines
    available_before = start_line - first_line
    available_after = last_line - end_line

    before_count = min(available_before, remaining // 2)
    after_count = min(available_after, remaining - before_count)

    unused = remaining - before_count - after_count
    before_count += min(available_before - before_count, unused)
    unused = remaining - before_count - after_count
    after_count += min(available_after - after_count, unused)

    selected_start = start_line - before_count
    selected_end = end_line + after_count
    selected = list(range(selected_start, selected_end + 1))
    if selected_start > first_line:
        selected.insert(0, None)
    if selected_end < last_line:
        selected.append(None)
    return selected


def extract_snippet(
    path: Path,
    start_line: int,
    end_line: int,
    context_lines: int = DEFAULT_CONTEXT_LINES,
    *,
    max_lines: int = DEFAULT_MAX_LINES,
) -> str:
    """读取指定源码范围，并返回带行号和有限上下文的代码片段。"""

    _validate_arguments(path, start_line, end_line, context_lines, max_lines)

    if not path.exists():
        raise FileNotFoundError(path)
    if not path.is_file():
        raise ValueError("path 必须指向普通文件")

    lines = path.read_text(encoding="utf-8").splitlines()
    if start_line > len(lines):
        raise ValueError("start_line 超出文件行数")

    actual_end_line = min(end_line, len(lines))
    first_line = max(1, start_line - context_lines)
    last_line = min(len(lines), actual_end_line + context_lines)
    line_numbers = _select_line_numbers(
        first_line,
        start_line,
        actual_end_line,
        last_line,
        max_lines,
    )
    return _render_lines(lines, line_numbers)
