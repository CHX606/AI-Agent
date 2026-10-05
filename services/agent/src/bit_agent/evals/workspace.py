"""评测工作区的受控复制、文件快照与差异生成。"""

import difflib
import hashlib
import os
import shutil
from collections.abc import Mapping
from pathlib import Path, PurePosixPath

from bit_agent.evals.models import EvalCase, FileChanges


def _is_junction(path: Path) -> bool:
    is_junction = getattr(path, "is_junction", None)
    return bool(is_junction and is_junction())


def path_matches(path: str, patterns: list[str]) -> bool:
    """判断 POSIX 相对路径是否命中一条精确路径或 glob 规则。"""
    candidate = PurePosixPath(path)
    for pattern in patterns:
        if candidate.match(pattern) or (pattern.startswith("**/") and candidate.match(pattern[3:])):
            return True
        if pattern.endswith("/**"):
            directory = pattern[:-3].rstrip("/")
            if not any(character in directory for character in "*?[") and (
                path == directory or path.startswith(f"{directory}/")
            ):
                return True
    return False


def snapshot_workspace(workspace_root: Path, ignored_paths: list[str]) -> dict[str, str]:
    """用相对路径和 SHA-256 记录工作区内所有受评测文件。"""
    root = workspace_root.resolve()
    snapshot: dict[str, str] = {}

    for current_root, directory_names, file_names in os.walk(root, followlinks=False):
        current = Path(current_root)
        safe_directories: list[str] = []
        for name in sorted(directory_names, key=lambda value: (value.casefold(), value)):
            directory = current / name
            relative = directory.relative_to(root).as_posix()
            if directory.is_symlink() or _is_junction(directory):
                raise ValueError(f"评测工作区不允许包含符号链接或目录联接：{relative}")
            if not path_matches(f"{relative}/placeholder", ignored_paths):
                safe_directories.append(name)
        directory_names[:] = safe_directories

        for name in sorted(file_names, key=lambda value: (value.casefold(), value)):
            file_path = current / name
            relative = file_path.relative_to(root).as_posix()
            if file_path.is_symlink() or _is_junction(file_path):
                raise ValueError(f"评测工作区不允许包含符号链接或目录联接：{relative}")
            if path_matches(relative, ignored_paths):
                continue
            digest = hashlib.sha256(file_path.read_bytes()).hexdigest()
            snapshot[relative] = digest

    return dict(sorted(snapshot.items()))


def compare_snapshots(before: Mapping[str, str], after: Mapping[str, str]) -> FileChanges:
    """计算新增、修改和删除文件，结果始终稳定排序。"""
    before_paths = set(before)
    after_paths = set(after)
    return FileChanges(
        added=sorted(after_paths - before_paths),
        modified=sorted(path for path in before_paths & after_paths if before[path] != after[path]),
        deleted=sorted(before_paths - after_paths),
    )


def _read_diff_lines(path: Path) -> list[str] | None:
    if not path.is_file():
        return []
    try:
        return path.read_text(encoding="utf-8").splitlines(keepends=True)
    except UnicodeDecodeError:
        return None


def build_unified_diff(before_root: Path, after_root: Path, changes: FileChanges) -> str:
    """为实际文件变化生成适合保存和人工审核的 unified diff。"""
    sections: list[str] = []
    for relative in changes.all_paths:
        before_path = before_root / relative
        after_path = after_root / relative
        before_lines = _read_diff_lines(before_path)
        after_lines = _read_diff_lines(after_path)
        if before_lines is None or after_lines is None:
            sections.append(f"Binary files a/{relative} and b/{relative} differ\n")
            continue
        sections.extend(
            difflib.unified_diff(
                before_lines,
                after_lines,
                fromfile=f"a/{relative}",
                tofile=f"b/{relative}",
            )
        )
    return "".join(sections)


def prepare_workspace(case: EvalCase, workspace: Path) -> dict[str, str]:
    # 复制前拒绝 Fixture 中的链接，避免 copytree 跟随到工作区外。
    fixture_snapshot = snapshot_workspace(case.fixture_path, case.ignored_paths)
    shutil.copytree(case.fixture_path, workspace)
    before = snapshot_workspace(workspace, case.ignored_paths)
    if before != fixture_snapshot:
        raise RuntimeError("Fixture 复制结果与原始文件快照不一致")
    return before
