"""把任务改过的文件提交到用户的 Git 仓库。只在用户点击提交时运行，只提交本次任务的文件。"""

import asyncio
import os
import shutil
from pathlib import Path

from bit_agent.runtime.domain.errors import InteractionError

GIT_TIMEOUT_SECONDS = 120


def git_executable() -> str:
    """优先用用户自己安装的 Git（带个人配置和钩子需要的 sh），没有时才用随包附带的。"""
    configured = os.getenv("BIT_AGENT_GIT")
    if configured:
        return configured
    project = os.getenv("BIT_AGENT_PROJECT_ROOT")
    bundled = (Path(project).parent / "tools").resolve() if project else None
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        if not directory.strip():
            continue
        try:
            if bundled is not None and Path(directory).resolve() == bundled:
                continue
        except OSError:
            continue
        found = shutil.which("git", path=directory)
        if found:
            return found
    return shutil.which("git") or "git"


async def _git(root: Path, *args: str) -> tuple[int, str, str]:
    try:
        process = await asyncio.create_subprocess_exec(
            git_executable(),
            "--literal-pathspecs",
            "-C",
            str(root),
            *args,
            # 运行服务的标准输入是 RPC 管道；Windows 上继承它会让进程创建卡到下一条请求。
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
    except OSError as exc:
        raise InteractionError(f"找不到 Git：{exc}", 503) from exc
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), GIT_TIMEOUT_SECONDS)
    except TimeoutError:
        process.kill()
        await process.communicate()
        raise InteractionError("Git 命令超时（可能是提交钩子运行太久）") from None
    return (
        process.returncode or 0,
        stdout.decode("utf-8", errors="replace"),
        stderr.decode("utf-8", errors="replace"),
    )


def _failure(action: str, stderr: str) -> InteractionError:
    detail = "\n".join(line for line in stderr.strip().splitlines() if line.strip())[-1500:]
    return InteractionError(f"{action}失败：{detail or '没有输出错误信息'}")


class GitRepository:
    async def status(self, root: Path, paths: list[str]) -> dict:
        """本次任务的文件里，哪些相对当前提交有改动。"""
        code, prefix, _ = await _git(root, "rev-parse", "--show-prefix")
        if code != 0:
            return {"repository": False, "branch": None, "files": []}
        code, branch, _ = await _git(root, "symbolic-ref", "--short", "-q", "HEAD")
        files: list[dict] = []
        if paths:
            code, output, stderr = await _git(
                root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", *paths
            )
            if code != 0:
                raise _failure("读取 Git 状态", stderr)
            # porcelain 输出的是相对仓库根目录的路径；换回相对工作区的路径。
            prefix = prefix.strip()
            entries = output.split("\0")
            index = 0
            while index < len(entries):
                entry = entries[index]
                index += 1
                if len(entry) < 4:
                    continue
                state, path = entry[:2], entry[3:]
                if state[0] in "RC":
                    index += 1  # 重命名还跟着原路径
                if prefix and path.startswith(prefix):
                    path = path[len(prefix) :]
                files.append({"path": path, "status": state.strip() or state})
        return {"repository": True, "branch": branch.strip() or None, "files": files}

    async def commit(
        self, root: Path, paths: list[str], message: str, branch: str | None = None
    ) -> dict:
        state = await self.status(root, paths)
        if not state["repository"]:
            raise InteractionError("工作区不在 Git 仓库里")
        files = [item["path"] for item in state["files"]]
        if not files:
            raise InteractionError("这些文件相对当前提交没有改动，不需要提交")
        if branch:
            code, _, stderr = await _git(root, "check-ref-format", "--branch", branch)
            if code != 0:
                raise InteractionError(f"分支名不合法：{branch}", 400)
            code, _, stderr = await _git(root, "switch", "-c", branch)
            if code != 0:
                raise _failure("创建分支", stderr)
        code, _, stderr = await _git(root, "add", "-A", "--", *files)
        if code != 0:
            raise _failure("暂存文件", stderr)
        # --only：只提交这些文件，用户自己暂存的其他改动保持原样。
        code, _, stderr = await _git(root, "commit", "--only", "-m", message, "--", *files)
        if code != 0:
            raise _failure("提交", stderr)
        _, commit, _ = await _git(root, "rev-parse", "--short=12", "HEAD")
        _, current, _ = await _git(root, "symbolic-ref", "--short", "-q", "HEAD")
        return {"commit": commit.strip(), "branch": current.strip() or None, "files": files}
