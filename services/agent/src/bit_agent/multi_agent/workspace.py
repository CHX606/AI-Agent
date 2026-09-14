"""为并发子 Agent 创建和清理彼此隔离的仓库副本。"""

import asyncio
import os
import shutil
import stat
import tempfile
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

DEFAULT_IGNORED_NAMES = frozenset(
    {
        ".git",
        ".mypy_cache",
        ".pytest_cache",
        ".bit-agent-subagents",
        ".ruff_cache",
        ".venv",
        "__pycache__",
        "artifacts",
        "logs",
        "node_modules",
    }
)


class IsolatedWorkspaceManager:
    """复制工作区；子任务结束后无论成功失败都清理副本。"""

    def __init__(
        self,
        temporary_root: Path | None = None,
        *,
        ignored_names: frozenset[str] = DEFAULT_IGNORED_NAMES,
    ) -> None:
        self.temporary_root = temporary_root.resolve() if temporary_root else None
        self.ignored_names = ignored_names
        if self.temporary_root is not None:
            self.temporary_root.mkdir(parents=True, exist_ok=True)

    @asynccontextmanager
    async def create(self, source: Path, task_id: str) -> AsyncIterator[Path]:
        source_root = source.resolve()
        if not source_root.is_dir():
            raise ValueError(f"工作区不存在：{source_root}")

        parent = Path(
            await asyncio.to_thread(
                tempfile.mkdtemp,
                prefix=f"bit-agent-subagent-{task_id}-",
                dir=str(self.temporary_root) if self.temporary_root else None,
            )
        )
        workspace = parent / "workspace"
        try:
            await asyncio.to_thread(
                shutil.copytree,
                source_root,
                workspace,
                symlinks=True,
                ignore=self._ignore,
            )
            yield workspace
        finally:
            await asyncio.to_thread(_remove_tree, parent)

    def _ignore(self, _directory: str, names: list[str]) -> set[str]:
        return {name for name in names if name in self.ignored_names}


def _remove_tree(path: Path) -> None:
    if not path.exists():
        return

    def make_writable_and_retry(
        function: Callable[[str], object], target: str, _error: BaseException
    ) -> None:
        os.chmod(target, stat.S_IWRITE)
        function(target)

    shutil.rmtree(path, onexc=make_writable_and_retry)
