"""安全解析并应用 Git unified diff 或 Begin Patch 补丁。"""

import asyncio
import difflib
import os
import re
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter

from bit_agent.security.paths import PathSecurityError, resolve_workspace_path
from bit_agent.tools.common import path_error_result, result, truncate_text
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolResult, ToolStatus

_HUNK_HEADER = re.compile(
    r"^@@ -(?:\d+)(?:,(?P<old_count>\d+))? "
    r"\+(?:\d+)(?:,(?P<new_count>\d+))? @@"
)
_GIT_ESCAPES = {
    "a": 7,
    "b": 8,
    "t": 9,
    "n": 10,
    "v": 11,
    "f": 12,
    "r": 13,
    '"': 34,
    "\\": 92,
}
_MISSING = object()


class PatchParseError(ValueError):
    """补丁不是受支持的安全文本补丁。"""


class PatchFileLimitError(PatchParseError):
    """Begin Patch 在转换前已经超过文件数量上限。"""

    def __init__(self, count: int, limit: int) -> None:
        super().__init__(f"补丁涉及 {count} 个路径，超过上限 {limit}")
        self.count = count
        self.limit = limit


@dataclass(frozen=True, slots=True)
class _ProcessOutcome:
    returncode: int | None
    stdout: bytes = b""
    stderr: bytes = b""
    timed_out: bool = False
    start_error: str | None = None


@dataclass(frozen=True, slots=True)
class _BeginPatchOperation:
    action: str
    path: str
    body: tuple[str, ...]


def _parse_begin_patch(patch: str) -> list[_BeginPatchOperation]:
    """解析 Codex 风格的 Begin Patch 外层格式。"""
    lines = patch.splitlines()
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()

    if not lines or lines[0] != "*** Begin Patch":
        raise PatchParseError("Begin Patch 补丁缺少起始标记")
    if lines[-1] != "*** End Patch":
        raise PatchParseError("Begin Patch 补丁缺少结束标记")

    operations: list[_BeginPatchOperation] = []
    seen_paths: set[str] = set()
    action: str | None = None
    path: str | None = None
    body: list[str] = []
    section_header = re.compile(r"^\*\*\* (Add|Update|Delete) File: (.+)$")

    def finish_operation() -> None:
        nonlocal action, path, body
        if action is None or path is None:
            return
        if path in seen_paths:
            raise PatchParseError(f"Begin Patch 对同一路径定义了多次操作：{path}")
        seen_paths.add(path)
        operations.append(_BeginPatchOperation(action, path, tuple(body)))
        action = None
        path = None
        body = []

    for line in lines[1:-1]:
        match = section_header.match(line)
        if match is not None:
            finish_operation()
            action = match.group(1).lower()
            path = match.group(2).strip()
            if not path:
                raise PatchParseError("Begin Patch 包含空文件路径")
            continue

        if line.startswith("*** "):
            raise PatchParseError(f"Begin Patch 包含不支持的指令：{line}")
        if action is None:
            raise PatchParseError("Begin Patch 的内容必须位于文件操作之后")
        body.append(line)

    finish_operation()
    if not operations:
        raise PatchParseError("Begin Patch 中没有文件操作")
    return operations


def _read_patch_text_file(target: Path, path: str) -> list[str]:
    """读取待修改文本，并为确定性转换保留其逻辑行。"""
    if not target.exists():
        raise PatchParseError(f"Begin Patch 的目标文件不存在：{path}")
    if not target.is_file():
        raise PatchParseError(f"Begin Patch 的目标不是普通文件：{path}")

    try:
        data = target.read_bytes()
    except OSError as exc:
        raise PatchParseError(f"无法读取 Begin Patch 的目标文件：{path}") from exc
    if b"\x00" in data:
        raise PatchParseError(f"Begin Patch 不支持二进制文件：{path}")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PatchParseError(f"Begin Patch 的目标文件不是有效 UTF-8：{path}") from exc
    if text and not text.endswith(("\n", "\r")):
        raise PatchParseError(f"Begin Patch 暂不支持修改末尾没有换行符的文件：{path}")
    return text.splitlines()


def _parse_begin_patch_hunks(path: str, body: tuple[str, ...]) -> list[list[str]]:
    hunks: list[list[str]] = []
    current: list[str] | None = None

    for line in body:
        if line.startswith("@@"):
            if current is not None:
                if not current:
                    raise PatchParseError(f"Begin Patch 包含空修改区块：{path}")
                hunks.append(current)
            current = []
            continue

        if current is None:
            raise PatchParseError(f"Update File 缺少 @@ 修改区块：{path}")
        if not line or line[0] not in {" ", "+", "-"}:
            raise PatchParseError(f"Begin Patch 修改行缺少空格、+ 或 - 标记：{path}")
        current.append(line)

    if current is None:
        raise PatchParseError(f"Update File 缺少 @@ 修改区块：{path}")
    if not current:
        raise PatchParseError(f"Begin Patch 包含空修改区块：{path}")
    hunks.append(current)
    return hunks


def _apply_begin_patch_hunks(
    path: str,
    original_lines: list[str],
    body: tuple[str, ...],
) -> list[str]:
    """通过唯一精确上下文匹配，将 Begin Patch 区块应用到内存。"""
    lines = list(original_lines)
    search_from = 0
    hunks = _parse_begin_patch_hunks(path, body)

    for hunk in hunks:
        old_lines = [line[1:] for line in hunk if line[0] in {" ", "-"}]
        new_lines = [line[1:] for line in hunk if line[0] in {" ", "+"}]

        if not old_lines:
            if lines or len(hunks) != 1:
                raise PatchParseError(f"Begin Patch 的纯插入区块必须提供唯一上下文：{path}")
            position = 0
        else:
            final_start = len(lines) - len(old_lines)
            matches = [
                index
                for index in range(search_from, final_start + 1)
                if lines[index : index + len(old_lines)] == old_lines
            ]
            if not matches:
                raise PatchParseError(f"Begin Patch 的修改上下文与文件不匹配：{path}")
            if len(matches) > 1:
                raise PatchParseError(f"Begin Patch 的修改上下文匹配到多处：{path}")
            position = matches[0]

        lines[position : position + len(old_lines)] = new_lines
        search_from = position + len(new_lines)

    if lines == original_lines:
        raise PatchParseError(f"Begin Patch 没有产生实际修改：{path}")
    return lines


def _quote_git_path(path: str) -> str:
    """按 Git C 风格路径规则编码空格、控制字符和非 ASCII 字节。"""
    data = path.encode("utf-8")
    needs_quotes = any(byte <= 32 or byte >= 127 or byte in {34, 92} for byte in data)
    if not needs_quotes:
        return path

    encoded: list[str] = []
    escapes = {9: r"\t", 10: r"\n", 13: r"\r", 34: r"\"", 92: r"\\"}
    for byte in data:
        if byte in escapes:
            encoded.append(escapes[byte])
        elif 32 <= byte < 127:
            encoded.append(chr(byte))
        else:
            encoded.append(f"\\{byte:03o}")
    return f'"{"".join(encoded)}"'


def _build_git_diff(
    path: str,
    old_lines: list[str],
    new_lines: list[str],
    *,
    action: str,
) -> str:
    old_path = "/dev/null" if action == "add" else _quote_git_path(f"a/{path}")
    new_path = "/dev/null" if action == "delete" else _quote_git_path(f"b/{path}")
    diff_old_path = _quote_git_path(f"a/{path}")
    diff_new_path = _quote_git_path(f"b/{path}")
    unified_lines = difflib.unified_diff(
        old_lines,
        new_lines,
        fromfile=old_path,
        tofile=new_path,
        n=3,
        lineterm="",
    )
    mode_header = ""
    if action == "add":
        mode_header = "new file mode 100644\n"
    elif action == "delete":
        mode_header = "deleted file mode 100644\n"
    return (
        f"diff --git {diff_old_path} {diff_new_path}\n"
        + mode_header
        + "\n".join(unified_lines)
        + "\n"
    )


def _convert_begin_patch(context: ToolContext, patch: str) -> str:
    """把 Begin Patch 安全转换成现有执行链消费的 Git unified diff。"""
    converted: list[str] = []
    converted_paths: set[str] = set()
    operations = _parse_begin_patch(patch)
    if len(operations) > context.max_patch_files:
        raise PatchFileLimitError(len(operations), context.max_patch_files)

    for operation in operations:
        target = resolve_workspace_path(context.workspace_root, operation.path)
        relative_path = target.relative_to(context.workspace_root).as_posix()
        if relative_path in converted_paths:
            raise PatchParseError(f"Begin Patch 对同一路径定义了多次操作：{relative_path}")
        converted_paths.add(relative_path)

        if operation.action == "add":
            if target.exists():
                raise PatchParseError(f"Add File 的目标已经存在：{operation.path}")
            if not operation.body or any(not line.startswith("+") for line in operation.body):
                raise PatchParseError(
                    f"Add File 的每一行都必须以 + 开头且内容不能为空：{operation.path}"
                )
            old_lines: list[str] = []
            new_lines = [line[1:] for line in operation.body]
        elif operation.action == "update":
            old_lines = _read_patch_text_file(target, operation.path)
            new_lines = _apply_begin_patch_hunks(
                operation.path,
                old_lines,
                operation.body,
            )
        else:
            if operation.body:
                raise PatchParseError(f"Delete File 操作不能包含补丁内容：{operation.path}")
            old_lines = _read_patch_text_file(target, operation.path)
            if not old_lines:
                raise PatchParseError(f"Begin Patch 暂不支持删除空文件：{operation.path}")
            new_lines = []

        converted.append(
            _build_git_diff(
                relative_path,
                old_lines,
                new_lines,
                action=operation.action,
            )
        )

    return "".join(converted)


def _normalize_supported_patch(context: ToolContext, patch: str) -> str:
    first_non_empty = next((line for line in patch.splitlines() if line), "")
    if first_non_empty == "*** Begin Patch":
        return _convert_begin_patch(context, patch)
    return patch


def _decode_quoted_git_path(text: str, start: int) -> tuple[str, int]:
    """解码 Git 使用的双引号和 C 风格转义路径。"""
    data = bytearray()
    index = start + 1

    while index < len(text):
        character = text[index]
        if character == '"':
            try:
                return data.decode("utf-8"), index + 1
            except UnicodeDecodeError as exc:
                raise PatchParseError("补丁路径不是有效的 UTF-8") from exc

        if character != "\\":
            data.extend(character.encode("utf-8"))
            index += 1
            continue

        index += 1
        if index >= len(text):
            raise PatchParseError("补丁路径包含不完整的转义字符")

        escaped = text[index]
        if escaped in _GIT_ESCAPES:
            data.append(_GIT_ESCAPES[escaped])
            index += 1
            continue

        if escaped in "01234567":
            digits = escaped
            index += 1
            while index < len(text) and len(digits) < 3 and text[index] in "01234567":
                digits += text[index]
                index += 1
            data.append(int(digits, 8))
            continue

        raise PatchParseError("补丁路径包含不支持的转义字符")

    raise PatchParseError("补丁路径缺少结束引号")


def _split_git_words(text: str) -> list[str]:
    """切分 diff --git 行中的路径，同时保留安全的 Git 引号语义。"""
    words: list[str] = []
    index = 0

    while index < len(text):
        while index < len(text) and text[index].isspace():
            index += 1
        if index >= len(text):
            break

        if text[index] == '"':
            word, index = _decode_quoted_git_path(text, index)
        else:
            end = index
            while end < len(text) and not text[end].isspace():
                end += 1
            word = text[index:end]
            index = end

        if not word:
            raise PatchParseError("补丁包含空文件路径")
        words.append(word)

    return words


def _normalize_patch_path(path: str) -> str | None:
    if path == "/dev/null":
        return None
    if path.startswith(("a/", "b/")):
        path = path[2:]
    if not path:
        raise PatchParseError("补丁包含空文件路径")
    return path


def _parse_header_path(value: str) -> str | None:
    words = _split_git_words(value)
    if len(words) != 1:
        raise PatchParseError("补丁文件路径格式无效")
    return _normalize_patch_path(words[0])


def _parse_patch_changes(patch: str) -> tuple[list[str], bool]:
    """解析文件头中的路径和删除操作，区块正文不作为操作指令。"""
    affected: list[str] = []
    seen: set[str] = set()
    deletes_files = False
    pending_old: str | None | object = _MISSING
    old_remaining = 0
    new_remaining = 0

    def add(path: str | None) -> None:
        if path is not None and path not in seen:
            seen.add(path)
            affected.append(path)

    for line in patch.splitlines():
        if old_remaining or new_remaining:
            if line == r"\ No newline at end of file":
                continue
            if not line:
                raise PatchParseError("补丁区块包含无效的空行")

            marker = line[0]
            if marker == " ":
                old_remaining -= 1
                new_remaining -= 1
            elif marker == "-":
                old_remaining -= 1
            elif marker == "+":
                new_remaining -= 1
            else:
                raise PatchParseError("补丁区块内容格式无效")

            if old_remaining < 0 or new_remaining < 0:
                raise PatchParseError("补丁区块行数与头部不一致")
            continue

        if line == r"\ No newline at end of file":
            continue

        if line.startswith("diff --git "):
            if pending_old is not _MISSING:
                raise PatchParseError("补丁缺少新文件路径")
            words = _split_git_words(line.removeprefix("diff --git "))
            if len(words) != 2:
                raise PatchParseError("diff --git 必须包含两个文件路径")
            add(_normalize_patch_path(words[0]))
            add(_normalize_patch_path(words[1]))
            continue

        if line.startswith("--- "):
            if pending_old is not _MISSING:
                raise PatchParseError("补丁文件头不完整")
            pending_old = _parse_header_path(line.removeprefix("--- "))
            continue

        if line.startswith("+++ "):
            if pending_old is _MISSING:
                raise PatchParseError("补丁缺少旧文件路径")
            new_path = _parse_header_path(line.removeprefix("+++ "))
            if isinstance(pending_old, str) and new_path is None:
                deletes_files = True
            add(pending_old if isinstance(pending_old, str) else None)
            add(new_path)
            pending_old = _MISSING
            continue

        if line.startswith("deleted file mode "):
            # Git 删除空文件时可以只有 diff --git 和模式头，没有 ---/+++。
            deletes_files = True
            continue

        if line.startswith(("rename from ", "rename to ", "copy from ", "copy to ")):
            _, _, raw_path = line.partition(" ")
            _, _, raw_path = raw_path.partition(" ")
            add(_parse_header_path(raw_path))
            continue

        if line.startswith("@@"):
            match = _HUNK_HEADER.match(line)
            if match is None:
                raise PatchParseError("补丁区块头格式无效")
            old_remaining = int(match.group("old_count") or "1")
            new_remaining = int(match.group("new_count") or "1")
            continue

        if line.startswith(("GIT binary patch", "Binary files ")):
            raise PatchParseError("第一版 apply_patch 不支持二进制补丁")

    if pending_old is not _MISSING:
        raise PatchParseError("补丁缺少新文件路径")
    if old_remaining or new_remaining:
        raise PatchParseError("补丁区块内容不完整")
    if not affected:
        raise PatchParseError("补丁中没有可识别的文件路径")

    return affected, deletes_files


def _parse_affected_paths(patch: str) -> list[str]:
    """解析补丁涉及的全部旧路径和新路径。"""
    return _parse_patch_changes(patch)[0]


def patch_deletes_files(normalized_patch: str) -> bool:
    """供权限关卡识别已规范化补丁的删除语义。"""
    return _parse_patch_changes(normalized_patch)[1]


async def _run_git_apply(
    workspace_root: str,
    patch_bytes: bytes,
    *,
    check: bool,
    timeout: float,
) -> _ProcessOutcome:
    arguments = ["git", "apply", "--no-index", "--whitespace=nowarn"]
    if check:
        arguments.append("--check")
    arguments.append("-")

    # 临时工作区经常位于另一个 Git 仓库内部。若 Git 向上发现父仓库，
    # 它会把相对补丁路径视为当前子目录之外并静默跳过，退出码仍可能为 0。
    # 把发现边界设为工作区父目录，既允许使用工作区自己的 .git，又不会
    # 让补丁意外绑定到外层仓库。
    environment = os.environ.copy()
    workspace_parent = str(Path(workspace_root).resolve().parent)
    existing_ceilings = environment.get("GIT_CEILING_DIRECTORIES")
    environment["GIT_CEILING_DIRECTORIES"] = (
        os.pathsep.join((workspace_parent, existing_ceilings))
        if existing_ceilings
        else workspace_parent
    )

    try:
        process = await asyncio.create_subprocess_exec(
            *arguments,
            cwd=workspace_root,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=environment,
        )
    except OSError as exc:
        return _ProcessOutcome(returncode=None, start_error=str(exc))

    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(patch_bytes),
            timeout=max(0.001, timeout),
        )
    except TimeoutError:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        stdout, stderr = await process.communicate()
        return _ProcessOutcome(
            returncode=process.returncode,
            stdout=stdout,
            stderr=stderr,
            timed_out=True,
        )

    return _ProcessOutcome(
        returncode=process.returncode,
        stdout=stdout,
        stderr=stderr,
    )


def _process_output(outcome: _ProcessOutcome, max_bytes: int) -> tuple[str, bool]:
    stdout = outcome.stdout.decode("utf-8", errors="replace").strip()
    stderr = outcome.stderr.decode("utf-8", errors="replace").strip()
    combined = "\n".join(part for part in (stdout, stderr) if part)
    return truncate_text(combined, max_bytes)


async def apply_patch(context: ToolContext, patch: str) -> ToolResult:
    """校验、规范化并原子地应用一个受限文本补丁。"""
    started = perf_counter()

    if not isinstance(patch, str) or not patch.strip() or "\x00" in patch:
        return result(
            context,
            "apply_patch",
            started,
            status=ToolStatus.ERROR,
            code="INVALID_ARGUMENT",
            message="patch 必须是非空且不含空字节的字符串",
            retryable=True,
        )

    try:
        patch_bytes = patch.encode("utf-8")
    except UnicodeEncodeError:
        return result(
            context,
            "apply_patch",
            started,
            status=ToolStatus.ERROR,
            code="INVALID_ARGUMENT",
            message="patch 必须是有效的 UTF-8 文本",
            retryable=True,
        )

    if len(patch_bytes) > context.max_patch_bytes:
        return result(
            context,
            "apply_patch",
            started,
            status=ToolStatus.REJECTED,
            code="PATCH_TOO_LARGE",
            message=f"补丁超过 {context.max_patch_bytes} 字节",
        )

    try:
        patch = _normalize_supported_patch(context, patch)
    except PathSecurityError as exc:
        return path_error_result(context, "apply_patch", started, exc)
    except PatchFileLimitError as exc:
        return result(
            context,
            "apply_patch",
            started,
            status=ToolStatus.REJECTED,
            code="TOO_MANY_FILES",
            message=str(exc),
        )
    except PatchParseError as exc:
        return result(
            context,
            "apply_patch",
            started,
            status=ToolStatus.ERROR,
            code="PATCH_REJECTED",
            message=str(exc),
            retryable=True,
        )

    patch_bytes = patch.encode("utf-8")
    if len(patch_bytes) > context.max_patch_bytes:
        return result(
            context,
            "apply_patch",
            started,
            status=ToolStatus.REJECTED,
            code="PATCH_TOO_LARGE",
            message=f"转换后的补丁超过 {context.max_patch_bytes} 字节",
        )

    try:
        raw_paths = _parse_affected_paths(patch)
    except PatchParseError as exc:
        return result(
            context,
            "apply_patch",
            started,
            status=ToolStatus.ERROR,
            code="PATCH_REJECTED",
            message=str(exc),
            retryable=True,
        )

    if len(raw_paths) > context.max_patch_files:
        return result(
            context,
            "apply_patch",
            started,
            status=ToolStatus.REJECTED,
            code="TOO_MANY_FILES",
            message=f"补丁涉及 {len(raw_paths)} 个路径，超过上限 {context.max_patch_files}",
        )

    affected_paths: list[str] = []
    try:
        for raw_path in raw_paths:
            target = resolve_workspace_path(context.workspace_root, raw_path)
            relative = target.relative_to(context.workspace_root).as_posix()
            if relative not in affected_paths:
                affected_paths.append(relative)
    except PathSecurityError as exc:
        return path_error_result(context, "apply_patch", started, exc)

    loop = asyncio.get_running_loop()
    deadline = loop.time() + context.timeout_seconds

    check_outcome = await _run_git_apply(
        str(context.workspace_root),
        patch_bytes,
        check=True,
        timeout=deadline - loop.time(),
    )
    if check_outcome.start_error is not None:
        return result(
            context,
            "apply_patch",
            started,
            status=ToolStatus.ERROR,
            code="INTERNAL_ERROR",
            message=f"无法启动 git：{check_outcome.start_error}",
        )

    check_output, check_truncated = _process_output(
        check_outcome,
        context.max_output_bytes,
    )
    if check_outcome.timed_out:
        return result(
            context,
            "apply_patch",
            started,
            status=ToolStatus.TIMEOUT,
            output=check_output or None,
            code="PROCESS_TIMEOUT",
            message=f"补丁预检超过 {context.timeout_seconds} 秒",
            retryable=True,
            truncated=check_truncated,
            paths=affected_paths,
        )
    if check_outcome.returncode != 0:
        return result(
            context,
            "apply_patch",
            started,
            status=ToolStatus.ERROR,
            output=check_output or None,
            code="PATCH_REJECTED",
            message=check_output or "git apply --check 拒绝了补丁",
            retryable=True,
            truncated=check_truncated,
            paths=affected_paths,
        )

    apply_outcome = await _run_git_apply(
        str(context.workspace_root),
        patch_bytes,
        check=False,
        timeout=deadline - loop.time(),
    )
    if apply_outcome.start_error is not None:
        return result(
            context,
            "apply_patch",
            started,
            status=ToolStatus.ERROR,
            code="INTERNAL_ERROR",
            message=f"无法启动 git：{apply_outcome.start_error}",
            paths=affected_paths,
        )

    apply_output, apply_truncated = _process_output(
        apply_outcome,
        context.max_output_bytes,
    )
    if apply_outcome.timed_out:
        return result(
            context,
            "apply_patch",
            started,
            status=ToolStatus.TIMEOUT,
            output=apply_output or None,
            code="PROCESS_TIMEOUT",
            message=f"应用补丁超过 {context.timeout_seconds} 秒",
            retryable=True,
            truncated=apply_truncated,
            paths=affected_paths,
        )
    if apply_outcome.returncode != 0:
        return result(
            context,
            "apply_patch",
            started,
            status=ToolStatus.ERROR,
            output=apply_output or None,
            code="PATCH_REJECTED",
            message=apply_output or "补丁预检通过，但应用失败",
            retryable=True,
            truncated=apply_truncated,
            paths=affected_paths,
        )

    return result(
        context,
        "apply_patch",
        started,
        status=ToolStatus.SUCCESS,
        output="Patch applied",
        paths=affected_paths,
    )
