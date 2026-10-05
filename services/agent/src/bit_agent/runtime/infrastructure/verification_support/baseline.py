"""失败检查需要前后比较时，复制安全文件并恢复原始内容。"""

import asyncio
import base64
import os
import shutil
from pathlib import Path

from bit_agent.security.paths import PathSecurityError, resolve_workspace_path

_CACHE_DIRECTORIES = frozenset(
    {"__pycache__", ".pnpm-store", ".pytest-tmp", ".pytest_cache", ".ruff_cache"}
)


def _allowed(root: Path, path: Path, excluded: set[Path]) -> bool:
    if path.is_symlink() or path.is_junction() or path.resolve(strict=False) in excluded:
        return False
    try:
        resolve_workspace_path(root, path.relative_to(root).as_posix())
    except PathSecurityError:
        return False
    return True


def _copy_directory(root: Path, source: Path, target: Path, excluded: set[Path]) -> None:
    with os.scandir(source) as iterator:
        entries = sorted(iterator, key=lambda item: (item.name.casefold(), item.name))
    for entry in entries:
        path = Path(entry.path)
        if not _allowed(root, path, excluded):
            continue
        if entry.is_dir(follow_symlinks=False):
            if entry.name.casefold() in _CACHE_DIRECTORIES:
                continue
            directory = target / entry.name
            directory.mkdir()
            _copy_directory(root, path, directory, excluded)
        elif entry.is_file(follow_symlinks=False):
            shutil.copyfile(path, target / entry.name)


def copy_workspace(root: Path, destination: Path, *, excluded_roots: tuple[Path, ...] = ()) -> None:
    """跳过链接、受保护文件和缓存，不给副本引入工作区之外的内容。"""
    root = root.resolve(strict=True)
    destination.mkdir()
    excluded = {destination.parent.resolve(), *(path.resolve() for path in excluded_roots)}
    _copy_directory(root, root, destination, excluded)


def _restore(root: Path, originals: dict[str, str | None], destination: Path) -> None:
    copy_workspace(root, destination)
    for name, content in originals.items():
        target = resolve_workspace_path(destination, name)
        if content is None:
            target.unlink(missing_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(content, validate=True))


async def write_baseline(root: Path, originals: dict[str, str | None], destination: Path) -> None:
    operation = asyncio.create_task(asyncio.to_thread(_restore, root, originals, destination))
    try:
        await asyncio.shield(operation)
    except asyncio.CancelledError:
        await operation
        raise
