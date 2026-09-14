"""使用 Docker CLI 启动一次性、无网络的只读测试容器。"""

import asyncio
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter
from uuid import uuid4

from bit_agent.sandbox.base import SandboxResult
from bit_agent.sandbox.environment import EnvironmentPreparationError, prepare_environment
from bit_agent.sandbox.node_environment import prepare_node_environment
from bit_agent.security.paths import PathSecurityError, resolve_workspace_path

DEFAULT_IMAGE = "bit-agent-python-sandbox:0.1.0"
SANDBOX_IMAGE_ENV = "BIT_AGENT_SANDBOX_IMAGE"
_TRUNCATION_MARKER = "\n... output truncated ...\n"
_IGNORED_CACHE_DIRECTORIES = frozenset(
    {"__pycache__", ".pnpm-store", ".pytest-tmp", ".pytest_cache", ".ruff_cache"}
)


def _elapsed_ms(started: float) -> int:
    return max(0, round((perf_counter() - started) * 1000))


def _truncate_text(text: str, max_bytes: int) -> tuple[str, bool]:
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text, False
    marker = _TRUNCATION_MARKER.encode()
    if max_bytes <= len(marker):
        return encoded[:max_bytes].decode("utf-8", errors="ignore"), True
    remaining = max_bytes - len(marker)
    head_size = remaining // 2
    tail_size = remaining - head_size
    head = encoded[:head_size].decode("utf-8", errors="ignore")
    tail = encoded[-tail_size:].decode("utf-8", errors="ignore")
    return head + _TRUNCATION_MARKER + tail, True


def _truncate_streams(stdout: str, stderr: str, limit: int) -> tuple[str, str, bool]:
    stdout_bytes = len(stdout.encode("utf-8"))
    stderr_bytes = len(stderr.encode("utf-8"))
    if stdout_bytes + stderr_bytes <= limit:
        return stdout, stderr, False

    stdout_budget = min(stdout_bytes, limit // 2)
    stderr_budget = min(stderr_bytes, limit // 2)
    remaining = limit - stdout_budget - stderr_budget
    stderr_extra = min(max(0, stderr_bytes - stderr_budget), remaining)
    stderr_budget += stderr_extra
    remaining -= stderr_extra
    stdout_budget += min(max(0, stdout_bytes - stdout_budget), remaining)

    rendered_stdout, stdout_truncated = _truncate_text(stdout, stdout_budget)
    rendered_stderr, stderr_truncated = _truncate_text(stderr, stderr_budget)
    return rendered_stdout, rendered_stderr, stdout_truncated or stderr_truncated


def _safe_name_part(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return normalized[:20] or "unknown"


@dataclass(frozen=True, slots=True)
class _DockerCommandOutcome:
    returncode: int | None
    stdout: bytes = b""


class DockerSandbox:
    """为每次调用创建受资源限制的短生命周期容器。"""

    def __init__(
        self,
        *,
        task_id: str,
        tool_call_id: str,
        image: str | None = None,
        max_output_bytes: int = 64 * 1024,
        docker_executable: str = "docker",
    ) -> None:
        if not task_id.strip() or not tool_call_id.strip():
            raise ValueError("task_id 和 tool_call_id 不能为空")
        resolved_image = image or os.getenv(SANDBOX_IMAGE_ENV, DEFAULT_IMAGE)
        if not resolved_image.strip() or not docker_executable.strip():
            raise ValueError("image 和 docker_executable 不能为空")
        if max_output_bytes <= 0:
            raise ValueError("max_output_bytes 必须大于 0")
        self.task_id = task_id
        self.tool_call_id = tool_call_id
        self.image = resolved_image
        self.environment_kind = "python"
        self.max_output_bytes = max_output_bytes
        self.docker_executable = docker_executable

    def _container_name(self) -> str:
        task = _safe_name_part(self.task_id)
        call = _safe_name_part(self.tool_call_id)
        return f"bit-agent-{task}-{call}-{uuid4().hex[:8]}"

    def _build_run_arguments(
        self,
        workspace_root: Path,
        command: list[str],
        container_name: str,
        cidfile: Path,
    ) -> list[str]:
        mount = f"type=bind,source={workspace_root},target=/workspace,readonly"
        return [
            self.docker_executable,
            "run",
            "--rm",
            "--name",
            container_name,
            "--cidfile",
            str(cidfile),
            "--network",
            "none",
            "--read-only",
            "--user",
            "10001:10001",
            "--memory",
            "512m",
            "--memory-swap",
            "512m",
            "--cpus",
            "1.0",
            "--pids-limit",
            "128",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--workdir",
            "/workspace",
            "--mount",
            mount,
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=64m",
            "--env",
            "PYTHONDONTWRITEBYTECODE=1",
            "--env",
            "PYTHONPYCACHEPREFIX=/tmp/pycache",
            "--env",
            "PYTEST_ADDOPTS=-p no:cacheprovider",
            "--env",
            "HOME=/tmp/home",
            "--env",
            "TMPDIR=/tmp",
            self.image,
            *command,
        ]

    @staticmethod
    def _is_junction(path: Path) -> bool:
        is_junction = getattr(path, "is_junction", None)
        return bool(is_junction and is_junction())

    def _stage_workspace(
        self, workspace_root: Path, destination: Path, *, excluded_roots: tuple[Path, ...] = ()
    ) -> None:
        """复制允许的工作区文件，避免把受保护文件暴露给容器。"""
        destination.mkdir()
        excluded = {destination.parent.resolve(), *(path.resolve() for path in excluded_roots)}

        def copy_directory(source: Path, target: Path) -> None:
            with os.scandir(source) as iterator:
                entries = sorted(iterator, key=lambda item: (item.name.casefold(), item.name))

            for entry in entries:
                source_path = Path(entry.path)
                if source_path.resolve(strict=False) in excluded:
                    continue
                if entry.is_symlink() or self._is_junction(source_path):
                    continue
                relative = source_path.relative_to(workspace_root).as_posix()
                try:
                    resolve_workspace_path(workspace_root, relative)
                except PathSecurityError:
                    continue

                if entry.is_dir(follow_symlinks=False):
                    if entry.name.casefold() in _IGNORED_CACHE_DIRECTORIES:
                        continue
                    target_directory = target / entry.name
                    target_directory.mkdir()
                    copy_directory(source_path, target_directory)
                elif entry.is_file(follow_symlinks=False):
                    shutil.copyfile(source_path, target / entry.name)

        copy_directory(workspace_root, destination)

    async def _docker_command(
        self,
        *arguments: str,
        timeout: float = 5.0,
    ) -> _DockerCommandOutcome:
        try:
            process = await asyncio.create_subprocess_exec(
                self.docker_executable,
                *arguments,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError:
            return _DockerCommandOutcome(None)

        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except TimeoutError:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.communicate()
            return _DockerCommandOutcome(None)
        return _DockerCommandOutcome(process.returncode, stdout)

    async def _cleanup_container(self, container_name: str) -> bool:
        await self._docker_command("stop", "--time", "1", container_name)
        await self._docker_command("rm", "--force", container_name)
        inspection = await self._docker_command(
            "ps",
            "--all",
            "--quiet",
            "--filter",
            f"name=^/{container_name}$",
        )
        if inspection.returncode != 0:
            return False
        if inspection.stdout.strip():
            await self._docker_command("rm", "--force", container_name)
            inspection = await self._docker_command(
                "ps",
                "--all",
                "--quiet",
                "--filter",
                f"name=^/{container_name}$",
            )
        return inspection.returncode == 0 and not inspection.stdout.strip()

    @staticmethod
    def _read_container_id(cidfile: Path, fallback: str | None = None) -> str | None:
        try:
            container_id = cidfile.read_text(encoding="utf-8").strip()
        except OSError:
            return fallback
        return container_id or fallback

    async def run(
        self,
        workspace_root: Path,
        command: list[str],
        timeout_seconds: float,
    ) -> SandboxResult:
        """运行命令，超时后停止、强制删除并确认容器不再存在。"""
        started = perf_counter()
        trusted_root = resolve_workspace_path(workspace_root, "", allow_root=True)
        if (
            not command
            or any(not isinstance(argument, str) or not argument for argument in command)
            or not isinstance(timeout_seconds, int | float)
            or isinstance(timeout_seconds, bool)
            or timeout_seconds <= 0
        ):
            raise ValueError("command 和 timeout_seconds 必须有效")

        container_name = self._container_name()
        try:
            if self.environment_kind == "node":
                prepared_image = await prepare_node_environment(
                    trusted_root, self.docker_executable
                )
                command = [
                    "sh",
                    "-c",
                    "mkdir -p /tmp/work && cp -R /workspace/. /tmp/work/ && "
                    "cp -R /opt/bit-agent/node_modules /tmp/work/node_modules && "
                    'cd /tmp/work && exec "$@"',
                    "sh",
                    *command,
                ]
            else:
                prepared_image = await prepare_environment(
                    trusted_root, self.image, self.docker_executable
                )
        except EnvironmentPreparationError as exc:
            return SandboxResult(
                container_id=None,
                exit_code=None,
                duration_ms=_elapsed_ms(started),
                start_error=str(exc),
            )
        with tempfile.TemporaryDirectory(prefix="bit-agent-sandbox-") as temporary_directory:
            staged_workspace = Path(temporary_directory) / "workspace"
            cidfile = Path(temporary_directory) / "container.cid"
            try:
                self._stage_workspace(trusted_root, staged_workspace)
            except OSError as exc:
                return SandboxResult(
                    container_id=None,
                    exit_code=None,
                    duration_ms=_elapsed_ms(started),
                    start_error=f"无法创建安全工作区快照：{exc}",
                )
            arguments = self._build_run_arguments(
                staged_workspace,
                command,
                container_name,
                cidfile,
            )
            arguments[arguments.index(self.image)] = prepared_image
            if self.environment_kind == "node":
                # 源码仍只读挂载。构建产物和依赖复制到容器临时目录，绝不落到用户目录。
                arguments[arguments.index("/tmp:rw,noexec,nosuid,nodev,size=64m")] = (
                    "/tmp:rw,nosuid,nodev,size=1536m"
                )
                arguments[arguments.index("512m")] = "2g"
                arguments[arguments.index("512m")] = "2g"
            try:
                process = await asyncio.create_subprocess_exec(
                    *arguments,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
            except OSError as exc:
                return SandboxResult(
                    container_id=None,
                    exit_code=None,
                    duration_ms=_elapsed_ms(started),
                    start_error=str(exc),
                )

            communicate_task = asyncio.create_task(process.communicate())
            timed_out = False
            cleanup_confirmed: bool | None = None
            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    asyncio.shield(communicate_task),
                    timeout=float(timeout_seconds),
                )
            except asyncio.CancelledError:
                await self._cleanup_container(container_name)
                if process.returncode is None:
                    process.kill()
                await communicate_task
                raise
            except TimeoutError:
                timed_out = True
                await self._cleanup_container(container_name)
                try:
                    stdout_bytes, stderr_bytes = await asyncio.wait_for(
                        asyncio.shield(communicate_task),
                        timeout=5.0,
                    )
                except TimeoutError:
                    if process.returncode is None:
                        process.kill()
                    stdout_bytes, stderr_bytes = await communicate_task
                cleanup_confirmed = await self._cleanup_container(container_name)

            container_id = self._read_container_id(
                cidfile,
                fallback=container_name if timed_out else None,
            )
            stdout = stdout_bytes.decode("utf-8", errors="replace")
            stderr = stderr_bytes.decode("utf-8", errors="replace")
            start_error = None
            if process.returncode != 0 and container_id is None and not timed_out:
                details = stderr.strip() or stdout.strip()
                start_error = details or f"docker run 启动失败，退出码：{process.returncode}"
            stdout, stderr, truncated = _truncate_streams(
                stdout,
                stderr,
                self.max_output_bytes,
            )
            return SandboxResult(
                container_id=container_id,
                exit_code=process.returncode,
                stdout=stdout,
                stderr=stderr,
                duration_ms=_elapsed_ms(started),
                timed_out=timed_out,
                cleanup_confirmed=cleanup_confirmed,
                truncated=truncated,
                start_error=start_error,
            )
