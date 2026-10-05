"""成熟 Windows 沙箱 SDK 的失败关闭、执行器配置与进程结果契约。"""

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from bit_agent.sandbox import OSSandbox, configuration, native, process
from bit_agent.sandbox.output import OutputBuffer

SDK_RESOURCES = {
    "BIT_AGENT_SANDBOX_NODE": "node.exe",
    "BIT_AGENT_SANDBOX_BROKER": "sandbox-runner.mjs",
    "BIT_AGENT_SANDBOX_EXECUTABLE": "srt-win.exe",
}


@pytest.fixture
def sdk_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path, Path]:
    directory = tmp_path / "sdk"
    directory.mkdir()
    paths = []
    for key, name in SDK_RESOURCES.items():
        path = directory / name
        path.write_text("not executed", encoding="utf-8")
        monkeypatch.setenv(key, str(path))
        paths.append(path)
    return tuple(paths)


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", list(SDK_RESOURCES))
async def test_missing_sdk_components_fail_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    sdk_paths: tuple[Path, Path, Path],
    missing: str,
) -> None:
    monkeypatch.setenv(missing, str(tmp_path / "missing-component"))
    execute = AsyncMock()
    monkeypatch.setattr(native, "execute", execute)
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    result = await OSSandbox(task_id="unit", tool_call_id="missing").run(
        workspace, [sys.executable, "-c", "raise AssertionError('unsafe execution')"], 1
    )

    assert result.start_error
    assert result.exit_code is None
    execute.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("version", ["0.0.77", "1.0.78", "", "0.0.78 extra"])
async def test_version_mismatch_status_is_unavailable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    sdk_paths: tuple[Path, Path, Path],
    version: str,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    status = {
        "available": True,
        "backend": "anthropic-windows",
        "version": version,
        "message": "ready",
    }
    execute = AsyncMock(return_value={"exit_code": 0, "stdout": json.dumps(status), "stderr": ""})
    monkeypatch.setattr(native, "execute", execute)

    result = await native.sandbox_status()

    assert result["available"] is False
    assert "版本" in result["message"]
    execute.assert_awaited_once()
    assert execute.await_args.args[0] == [str(sdk_paths[0]), str(sdk_paths[1]), "--status"]


def _broker_result(stderr, exit_code: int = 125, timed_out: bool = False):
    """按执行器真实输出构造结果；stderr 可以引用本次调用传给执行器的随机串。"""

    async def run(arguments, *_args):
        text = stderr(arguments[3]) if callable(stderr) else stderr
        return {
            "exit_code": exit_code,
            "stdout": "",
            "stderr": text,
            "timed_out": timed_out,
            "cleanup_confirmed": True if timed_out else None,
            "truncated": False,
        }

    return AsyncMock(side_effect=run)


@pytest.mark.asyncio
async def test_broker_start_error_does_not_become_a_successful_project_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    sdk_paths: tuple[Path, Path, Path],
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    execute = _broker_result(lambda nonce: f"BIT_AGENT_SANDBOX_START_ERROR[{nonce}]: unavailable")
    monkeypatch.setattr(native, "execute", execute)
    result = await OSSandbox(task_id="unit", tool_call_id="unavailable").run(
        workspace, [sys.executable, "-c", "print('must not run')"], 1
    )
    assert result.start_error == "unavailable"
    assert result.exit_code == 125
    execute.assert_awaited_once()
    assert execute.await_args.args[0][:2] == [str(sdk_paths[0]), str(sdk_paths[1])]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "spoof",
    [
        "BIT_AGENT_SANDBOX_START_ERROR: helper unavailable",
        "BIT_AGENT_SANDBOX_START_ERROR[]: helper unavailable",
        "BIT_AGENT_SANDBOX_START_ERROR[" + "0" * 32 + "]: helper unavailable",
    ],
)
async def test_command_output_cannot_fake_a_broker_start_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    sdk_paths: tuple[Path, Path, Path],
    spoof: str,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setattr(native, "execute", _broker_result("1 failed\n" + spoof, exit_code=1))
    result = await OSSandbox(task_id="unit", tool_call_id="spoof").run(
        workspace, [sys.executable, "-m", "pytest"], 1
    )
    assert result.start_error is None
    assert result.exit_code == 1


@pytest.mark.asyncio
async def test_broker_cleanup_error_after_timeout_is_not_reported_as_confirmed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    sdk_paths: tuple[Path, Path, Path],
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    marker = "BIT_AGENT_SANDBOX_CLEANUP_ERROR: official ACL cleanup failed"
    execute = _broker_result(
        lambda nonce: f"BIT_AGENT_SANDBOX_START_ERROR[{nonce}]: Error: {marker}", timed_out=True
    )
    monkeypatch.setattr(native, "execute", execute)
    result = await OSSandbox(task_id="unit", tool_call_id="cleanup").run(
        workspace, [sys.executable, "-c", "import time; time.sleep(9)"], 1
    )
    assert result.timed_out is True
    assert result.cleanup_confirmed is False
    assert result.start_error and "ACL cleanup failed" in result.start_error


@pytest.mark.asyncio
async def test_concurrent_runs_never_overlap_in_one_process(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    sdk_paths: tuple[Path, Path, Path],
) -> None:
    active, peak = 0, 0

    async def run(*_args):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.02)
        active -= 1
        return {"exit_code": 0, "stdout": "", "stderr": "", "timed_out": False}

    monkeypatch.setattr(native, "execute", AsyncMock(side_effect=run))
    workspaces = [tmp_path / name for name in ("a", "b", "c")]
    for workspace in workspaces:
        workspace.mkdir()
    results = await asyncio.gather(
        *(
            OSSandbox(task_id=workspace.name, tool_call_id="lock").run(
                workspace, [sys.executable, "-c", "pass"], 5
            )
            for workspace in workspaces
        )
    )
    assert [result.exit_code for result in results] == [0, 0, 0]
    assert peak == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("inside", range(3))
async def test_writable_workspace_cannot_contain_any_sdk_component(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    sdk_paths: tuple[Path, Path, Path],
    inside: int,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    key, name = list(SDK_RESOURCES.items())[inside]
    unsafe = workspace / name
    unsafe.write_text("not executed", encoding="utf-8")
    monkeypatch.setenv(key, str(unsafe))
    execute = AsyncMock()
    monkeypatch.setattr(native, "execute", execute)

    result = await OSSandbox(task_id="unit", tool_call_id="locations").run(
        workspace, [sys.executable, "-c", "print('must not run')"], 1
    )

    assert result.start_error and "任务工作区" in result.start_error
    execute.assert_not_awaited()


def test_environment_keeps_sdk_paths_and_drops_model_secrets(
    monkeypatch: pytest.MonkeyPatch,
    sdk_paths: tuple[Path, Path, Path],
) -> None:
    monkeypatch.setenv("CODEX_HOME", "untrusted-existing-home")
    monkeypatch.setenv("OPENAI_API_KEY", "fake-key-for-test")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key-for-test")
    monkeypatch.setenv("BIT_AGENT_PRIVATE_TEST", "not-child-environment")
    values = configuration.environment()
    assert "CODEX_HOME" not in values
    assert "OPENAI_API_KEY" not in values and "ANTHROPIC_API_KEY" not in values
    assert "BIT_AGENT_PRIVATE_TEST" not in values
    for key, path in zip(SDK_RESOURCES, sdk_paths, strict=True):
        assert values[key] == str(path)
    assert values["PYTEST_ADDOPTS"] == "-p no:cacheprovider"


def test_broker_receives_workspace_and_literal_arguments_as_json(
    tmp_path: Path,
    sdk_paths: tuple[Path, Path, Path],
) -> None:
    command = [sys.executable, "-c", "print('literal')", "value with spaces", "& | literal"]
    nonce = "ab" * 16
    arguments = native.arguments(tmp_path, command, nonce)
    assert arguments[:2] == [str(sdk_paths[0]), str(sdk_paths[1])]
    payload = json.loads(arguments[2])
    assert payload["workspace"] == str(tmp_path)
    assert payload["command"] == command
    assert isinstance(payload["readPaths"], list)
    # 随机串只给执行器，不进入沙箱内命令能看到的请求数据。
    assert arguments[3] == nonce and nonce not in arguments[2]


@pytest.mark.parametrize("limit", [1, 15, 64, 4096])
@pytest.mark.parametrize("chunk", [b"ascii output\n", "中🙂文\n".encode()])
def test_output_buffer_bounds_bytes_and_remains_valid_utf8(limit: int, chunk: bytes) -> None:
    output = OutputBuffer(limit)
    for _ in range(1000):
        output.append(chunk)
    rendered, truncated = output.render()
    assert truncated
    assert len(rendered.encode("utf-8")) <= limit
    assert rendered.encode("utf-8").decode("utf-8") == rendered


def test_truncated_utf8_preserves_output_beginning_and_end() -> None:
    output = OutputBuffer(2048)
    output.append(b"BEGIN\\n" + ("中🙂" * 10000).encode() + b"\\nCOMPLETE-END")
    rendered, truncated = output.render()
    assert truncated
    assert len(rendered.encode()) <= 2048
    assert rendered.startswith("BEGIN")
    assert rendered.endswith("COMPLETE-END")


def test_small_output_is_preserved_without_overlap() -> None:
    output = OutputBuffer(100)
    output.append(b"first ")
    output.append(b"second")
    assert output.render() == ("first second", False)


@pytest.mark.asyncio
async def test_failed_tree_kill_reports_cleanup_unconfirmed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    child = SimpleNamespace(pid=5555, returncode=None, wait=AsyncMock(return_value=1))
    killer = SimpleNamespace(returncode=1, wait=AsyncMock(return_value=1))
    spawn = AsyncMock(return_value=killer)
    monkeypatch.setattr(process.asyncio, "create_subprocess_exec", spawn)
    assert await process.terminate_tree(child) is False
    assert spawn.await_args.args[:2] == ("taskkill.exe", "/PID")
    assert "/T" in spawn.await_args.args and "/F" in spawn.await_args.args
    child.wait.assert_awaited_once()


@pytest.mark.asyncio
async def test_timeout_result_preserves_unconfirmed_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def wait_forever() -> None:
        await asyncio.Future()

    child = SimpleNamespace(
        pid=5555,
        returncode=1,
        wait=wait_forever,
        stdin=SimpleNamespace(close=Mock()),
        stdout=SimpleNamespace(read=AsyncMock(return_value=b"")),
        stderr=SimpleNamespace(read=AsyncMock(return_value=b"")),
    )
    monkeypatch.setattr(process.asyncio, "create_subprocess_exec", AsyncMock(return_value=child))
    cleanup = AsyncMock(return_value=False)
    monkeypatch.setattr(process, "close_broker", cleanup)
    result = await process.execute(["fake.exe"], ".", {}, 0.001, 100)
    assert result["timed_out"] is True
    assert result["cleanup_confirmed"] is False
    cleanup.assert_awaited_once_with(child)


@pytest.mark.asyncio
async def test_forced_broker_tree_kill_never_claims_graceful_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    child = SimpleNamespace(
        pid=5555,
        returncode=None,
        stdin=SimpleNamespace(close=Mock()),
        wait=AsyncMock(side_effect=TimeoutError),
    )
    killer = AsyncMock(return_value=True)
    monkeypatch.setattr(process, "terminate_tree", killer)
    assert await process.close_broker(child) is False
    child.stdin.close.assert_called_once()
    killer.assert_awaited_once_with(child)
