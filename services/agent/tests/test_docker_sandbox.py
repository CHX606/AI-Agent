import asyncio
import shutil
import subprocess
from pathlib import Path

import pytest
from bit_agent.sandbox import DEFAULT_IMAGE, DockerSandbox


def _docker_image_ready() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        completed = subprocess.run(
            ["docker", "image", "inspect", DEFAULT_IMAGE],
            check=False,
            capture_output=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0


DOCKER_IMAGE_READY = _docker_image_ready()


def _option_value(arguments: list[str], option: str) -> str:
    return arguments[arguments.index(option) + 1]


def test_docker_arguments_include_all_security_and_resource_limits(tmp_path: Path) -> None:
    sandbox = DockerSandbox(task_id="Task 42", tool_call_id="Call/7")
    name = sandbox._container_name()
    arguments = sandbox._build_run_arguments(
        tmp_path.resolve(),
        ["python", "-V"],
        name,
        tmp_path / "container.cid",
    )

    assert name.startswith("bit-agent-task-42-call-7-")
    assert "--rm" in arguments
    assert _option_value(arguments, "--network") == "none"
    assert "--read-only" in arguments
    assert _option_value(arguments, "--user") == "10001:10001"
    assert _option_value(arguments, "--memory") == "512m"
    assert _option_value(arguments, "--memory-swap") == "512m"
    assert _option_value(arguments, "--cpus") == "1.0"
    assert _option_value(arguments, "--pids-limit") == "128"
    assert _option_value(arguments, "--cap-drop") == "ALL"
    assert _option_value(arguments, "--security-opt") == "no-new-privileges"
    assert _option_value(arguments, "--workdir") == "/workspace"
    assert "target=/workspace,readonly" in _option_value(arguments, "--mount")
    assert _option_value(arguments, "--tmpfs").startswith("/tmp:rw,noexec,nosuid,nodev")
    assert "--privileged" not in arguments
    rendered = " ".join(arguments).casefold()
    assert "docker.sock" not in rendered
    assert ".ssh" not in rendered
    assert ".env" not in rendered
    assert arguments[-3:] == [DEFAULT_IMAGE, "python", "-V"]


def test_docker_image_can_be_selected_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BIT_AGENT_SANDBOX_IMAGE", "bit-agent-python-web-sandbox:0.1.0")

    sandbox = DockerSandbox(task_id="task", tool_call_id="call")

    assert sandbox.image == "bit-agent-python-web-sandbox:0.1.0"


def test_staged_workspace_excludes_secrets_and_protected_directories(tmp_path: Path) -> None:
    workspace = tmp_path / "source"
    destination = tmp_path / "staged"
    (workspace / "src").mkdir(parents=True)
    (workspace / ".git").mkdir()
    (workspace / "keys").mkdir()
    (workspace / "src" / "main.py").write_text("print('safe')", encoding="utf-8")
    (workspace / ".git" / "config").write_text("secret", encoding="utf-8")
    (workspace / ".env").write_text("TOKEN=secret", encoding="utf-8")
    (workspace / "keys" / "private.pem").write_text("secret", encoding="utf-8")
    sandbox = DockerSandbox(task_id="task", tool_call_id="call")

    sandbox._stage_workspace(workspace.resolve(), destination)

    assert (destination / "src" / "main.py").read_text(encoding="utf-8") == "print('safe')"
    assert not (destination / ".git").exists()
    assert not (destination / ".env").exists()
    assert not (destination / "keys" / "private.pem").exists()


@pytest.mark.asyncio
async def test_missing_docker_is_reported_as_start_error(tmp_path: Path) -> None:
    sandbox = DockerSandbox(
        task_id="task",
        tool_call_id="call",
        docker_executable="definitely-not-a-real-docker-command",
    )

    result = await sandbox.run(tmp_path, ["python", "-V"], 1)

    assert result.exit_code is None
    assert result.start_error
    assert not result.timed_out


@pytest.mark.asyncio
async def test_docker_cli_failure_before_container_creation_is_start_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sandbox = DockerSandbox(task_id="task", tool_call_id="call")

    class FakeProcess:
        returncode = 1

        async def communicate(self) -> tuple[bytes, bytes]:
            return b"", b"failed to connect to the docker API"

    async def fake_create_subprocess_exec(*arguments: str, **kwargs: object) -> FakeProcess:
        del arguments, kwargs
        return FakeProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    result = await sandbox.run(tmp_path, ["python", "-V"], 1)

    assert result.exit_code == 1
    assert result.container_id is None
    assert result.start_error == "failed to connect to the docker API"
    assert not result.timed_out


@pytest.mark.asyncio
async def test_timeout_triggers_stop_remove_and_confirmation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sandbox = DockerSandbox(task_id="task", tool_call_id="call")
    released = asyncio.Event()
    cleanup_names: list[str] = []

    class FakeProcess:
        returncode: int | None = None

        async def communicate(self) -> tuple[bytes, bytes]:
            await released.wait()
            self.returncode = 137
            return b"started", b"stopped"

        def kill(self) -> None:
            self.returncode = 137
            released.set()

    process = FakeProcess()

    async def fake_create_subprocess_exec(*arguments: str, **kwargs: object) -> FakeProcess:
        del kwargs
        cidfile = Path(arguments[arguments.index("--cidfile") + 1])
        cidfile.write_text("abc123", encoding="utf-8")
        return process

    async def fake_cleanup(container_name: str) -> bool:
        cleanup_names.append(container_name)
        released.set()
        return True

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(sandbox, "_cleanup_container", fake_cleanup)

    result = await sandbox.run(tmp_path, ["python", "-c", "pass"], 0.01)

    assert result.timed_out
    assert result.exit_code == 137
    assert result.container_id == "abc123"
    assert result.cleanup_confirmed is True
    assert len(cleanup_names) == 2
    assert cleanup_names[0] == cleanup_names[1]


@pytest.mark.asyncio
async def test_cleanup_uses_stop_force_remove_and_absence_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sandbox = DockerSandbox(task_id="task", tool_call_id="call")
    calls: list[tuple[str, ...]] = []

    inspections = 0

    async def fake_docker_command(*arguments: str, timeout: float = 5.0) -> object:
        nonlocal inspections
        del timeout
        calls.append(arguments)
        if arguments[0] == "ps":
            inspections += 1
            stdout = b"still-present" if inspections == 1 else b""
        else:
            stdout = b""
        return type("Outcome", (), {"returncode": 0, "stdout": stdout})()

    monkeypatch.setattr(sandbox, "_docker_command", fake_docker_command)

    cleaned = await sandbox._cleanup_container("bit-agent-task-call-1234")

    assert cleaned
    assert calls == [
        ("stop", "--time", "1", "bit-agent-task-call-1234"),
        ("rm", "--force", "bit-agent-task-call-1234"),
        (
            "ps",
            "--all",
            "--quiet",
            "--filter",
            "name=^/bit-agent-task-call-1234$",
        ),
        ("rm", "--force", "bit-agent-task-call-1234"),
        (
            "ps",
            "--all",
            "--quiet",
            "--filter",
            "name=^/bit-agent-task-call-1234$",
        ),
    ]


@pytest.mark.asyncio
async def test_long_stdout_and_stderr_are_truncated(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sandbox = DockerSandbox(
        task_id="task",
        tool_call_id="call",
        max_output_bytes=200,
    )

    class FakeProcess:
        returncode = 1

        async def communicate(self) -> tuple[bytes, bytes]:
            return (b"HEAD" + b"x" * 500 + b"TAIL", b"ERR" + b"y" * 500 + b"END")

    async def fake_create_subprocess_exec(*arguments: str, **kwargs: object) -> FakeProcess:
        del kwargs
        cidfile = Path(arguments[arguments.index("--cidfile") + 1])
        cidfile.write_text("abc123", encoding="utf-8")
        return FakeProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    result = await sandbox.run(tmp_path, ["python", "-c", "pass"], 1)

    assert result.truncated
    assert "output truncated" in result.stdout
    assert "output truncated" in result.stderr
    assert result.stdout.startswith("HEAD") and result.stdout.endswith("TAIL")
    assert result.stderr.startswith("ERR") and result.stderr.endswith("END")
    assert len(result.stdout.encode()) + len(result.stderr.encode()) <= 200


@pytest.mark.skipif(not DOCKER_IMAGE_READY, reason="Docker 或 Day 4 沙箱镜像不可用")
@pytest.mark.asyncio
async def test_real_container_returns_output_and_nonzero_exit(tmp_path: Path) -> None:
    sandbox = DockerSandbox(task_id="integration", tool_call_id="output")

    result = await sandbox.run(
        tmp_path,
        ["python", "-c", "import sys; print('out'); print('err', file=sys.stderr); sys.exit(3)"],
        5,
    )

    assert result.exit_code == 3
    assert result.stdout.strip() == "out"
    assert result.stderr.strip() == "err"


@pytest.mark.skipif(not DOCKER_IMAGE_READY, reason="Docker 或 Day 4 沙箱镜像不可用")
@pytest.mark.asyncio
async def test_real_container_has_no_network(tmp_path: Path) -> None:
    sandbox = DockerSandbox(task_id="integration", tool_call_id="network")
    script = (
        "import socket,sys; s=socket.socket(); s.settimeout(1); "
        "\ntry: s.connect(('1.1.1.1', 53))"
        "\nexcept OSError: print('blocked')"
        "\nelse: sys.exit(9)"
    )

    result = await sandbox.run(tmp_path, ["python", "-c", script], 5)

    assert result.exit_code == 0
    assert result.stdout.strip() == "blocked"


@pytest.mark.skipif(not DOCKER_IMAGE_READY, reason="Docker 或 Day 4 沙箱镜像不可用")
@pytest.mark.asyncio
async def test_real_timeout_leaves_no_container(tmp_path: Path) -> None:
    sandbox = DockerSandbox(task_id="integration", tool_call_id="timeout")

    result = await sandbox.run(
        tmp_path,
        ["python", "-c", "import time; time.sleep(10)"],
        0.2,
    )

    assert result.timed_out
    assert result.cleanup_confirmed is True
    completed = subprocess.run(
        ["docker", "ps", "--all", "--quiet", "--filter", "name=bit-agent-integration-timeout"],
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert completed.stdout.strip() == ""
