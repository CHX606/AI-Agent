"""Disposable test workspace and fixed, sandboxed test execution adapters."""

import asyncio
import hashlib
import json
import os
import re
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from bit_agent.sandbox.docker import DockerSandbox
from bit_agent.sandbox.node_environment import node_manifest
from bit_agent.security.paths import resolve_workspace_path
from bit_agent.tools.run_tests import _is_allowed_test_target


async def _finish_io(function, *args):
    # Do not delete a temporary directory while its background writer is still running.
    operation = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(operation)
    except asyncio.CancelledError:
        await operation
        raise


def _fingerprint(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path.is_file():
            digest.update(path.relative_to(root).as_posix().encode())
            digest.update(b"\0")
            with path.open("rb") as stream:
                digest.update(hashlib.file_digest(stream, "sha256").digest())
    return digest.hexdigest()


class AcceptanceWorkspace:
    def __init__(
        self, root: Path, artifacts: Path, *, excluded_roots: tuple[Path, ...] = ()
    ) -> None:
        self.source = root.resolve()
        self.artifacts = artifacts
        self.excluded_roots = (*excluded_roots, artifacts.resolve())
        self.identifier = uuid4().hex[:12]
        self.generated: set[Path] = set()
        self._temporary: TemporaryDirectory | None = None

    def _stage(self, destination: Path) -> None:
        DockerSandbox(task_id="acceptance", tool_call_id=self.identifier)._stage_workspace(
            self.source, destination, excluded_roots=self.excluded_roots
        )

    async def __aenter__(self):
        self._temporary = TemporaryDirectory(prefix="bit-agent-acceptance-")
        self.root = Path(self._temporary.name) / "workspace"
        try:
            await _finish_io(self._stage, self.root)
            self.snapshot_id = await _finish_io(_fingerprint, self.root)
            return self
        except BaseException:
            await self.__aexit__()
            raise

    async def __aexit__(self, *args):
        if self._temporary is not None:
            await _finish_io(self._temporary.cleanup)

    def _project(self, project: str) -> Path:
        directory = resolve_workspace_path(self.root, project, allow_root=True)
        if not directory.is_dir():
            raise ValueError("项目目录不存在")
        return directory

    async def write_test(self, project: str, filename: str, content: str) -> str:
        directory = self._project(project)
        if not re.fullmatch(
            r"test_[A-Za-z0-9_]+\.py|[A-Za-z0-9_]+\.test\.(?:[cm]?js|tsx?)", filename
        ):
            raise ValueError("只允许测试文件名，不能填写路径、配置文件或业务文件")
        if not content.strip() or len(content.encode("utf-8")) > 64000:
            raise ValueError("测试内容必须为 1 到 64000 UTF-8 字节")
        relative = (
            directory.relative_to(self.root)
            / "tests"
            / ("bit_agent_acceptance_" + self.identifier)
            / filename
        )
        target = resolve_workspace_path(self.root, relative.as_posix())
        if target.exists() and target not in self.generated:
            raise ValueError("不能覆盖已有文件")

        def write():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            archived = self.artifacts / "tests" / relative
            archived.parent.mkdir(parents=True, exist_ok=True)
            archived.write_text(content, encoding="utf-8")

        await _finish_io(write)
        self.generated.add(target)
        return target.relative_to(directory).as_posix()

    async def run_test(self, project: str, target: str, language: str, call_id: str) -> dict:
        directory = self._project(project)
        test_path = resolve_workspace_path(directory, target, allow_root=True)
        if not test_path.exists():
            raise ValueError("测试目标不存在")
        if target and not _is_allowed_test_target(test_path, directory):
            # The existing predicate is Python-specific for files.
            if not test_path.is_file() or not re.search(r"\.test\.(?:[cm]?js|tsx?)$", target):
                raise ValueError("只允许运行测试文件或测试目录")
        relative = test_path.relative_to(directory).as_posix()
        if language == "python" and (
            (directory / "pyproject.toml").is_file() or (directory / "pytest.ini").is_file()
        ):
            command = ["python", "-m", "pytest", "-q"]
            if target:
                command += ["--", relative]
        elif language == "node" and (directory / "package.json").is_file():
            manifest, manager, _ = node_manifest(directory)
            if not isinstance(manifest.get("scripts"), dict) or not manifest["scripts"].get("test"):
                raise ValueError("项目没有 test 脚本")
            command = [manager, "run", "test"]
            if target:
                command += ["--", "./" + relative]
        else:
            raise ValueError("目前只支持配置了 pytest 或 Node test 脚本的项目")
        sandbox = DockerSandbox(task_id="acceptance", tool_call_id=call_id)
        sandbox.environment_kind = language
        result = await sandbox.run(directory, command, 300)
        return {
            "project": project,
            "target": target,
            "language": language,
            "command": command,
            "exit_code": result.exit_code,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "start_error": result.start_error,
            "timed_out": result.timed_out,
            "truncated": result.truncated,
            "passed": not result.start_error and not result.timed_out and result.exit_code == 0,
            "dependency_note": "沿用项目隔离环境；Node 安装公开依赖，不重放锁文件。",
        }

    async def unchanged(self) -> bool:
        def check():
            with TemporaryDirectory(prefix="bit-agent-acceptance-check-") as directory:
                copy = Path(directory) / "workspace"
                self._stage(copy)
                return _fingerprint(copy) == self.snapshot_id

        return await _finish_io(check)

    async def save_report(self, report: dict) -> None:
        def save():
            self.artifacts.mkdir(parents=True, exist_ok=True)
            destination = self.artifacts / "report.json"
            temporary = self.artifacts / "report.tmp"
            with temporary.open("w", encoding="utf-8") as stream:
                json.dump(report, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(destination)

        await _finish_io(save)
