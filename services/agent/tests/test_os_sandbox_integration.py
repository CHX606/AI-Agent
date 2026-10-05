"""无需模型登录的Windows 沙箱 SDK真实隔离与清理验收。"""

import asyncio
import csv
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest
import pytest_asyncio
from bit_agent.sandbox import OSSandbox, configuration, sandbox_status
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolStatus
from bit_agent.tools.run_checks import run_checks

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="便携版使用 Windows 沙箱 SDK")
HARDEN_SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "harden-sandbox.ps1"
POWERSHELL = (
    Path(os.environ.get("SystemRoot", r"C:\Windows"))
    / "System32"
    / "WindowsPowerShell"
    / "v1.0"
    / "powershell.exe"
)
SDK_ENVIRONMENT_KEYS = (
    "BIT_AGENT_SANDBOX_NODE",
    "BIT_AGENT_SANDBOX_BROKER",
    "BIT_AGENT_SANDBOX_EXECUTABLE",
)


@pytest_asyncio.fixture
async def sandbox(monkeypatch: pytest.MonkeyPatch) -> OSSandbox:
    try:
        paths = configuration.runtime_paths()
    except (OSError, ValueError, RuntimeError) as exc:
        pytest.skip(f"Windows SDK 沙箱资源不可用：{exc}")
    for key, path in zip(SDK_ENVIRONMENT_KEYS, paths, strict=True):
        monkeypatch.setenv(key, str(path))
    status = await sandbox_status()
    if not status["available"]:
        pytest.skip(status["message"])
    return OSSandbox(
        task_id="security-integration", tool_call_id="native-test", max_output_bytes=4096
    )


@pytest.mark.asyncio
async def test_workspace_write_succeeds_and_parent_write_fails(
    tmp_path: Path, sandbox: OSSandbox
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside.txt"
    code = (
        "from pathlib import Path; "
        "Path('inside.txt').write_text('workspace allowed', encoding='utf-8'); "
        f"outside=Path({str(outside)!r}); "
        "\ntry: outside.write_text('must be denied', encoding='utf-8')"
        "\nexcept PermissionError: print('outside denied')"
        "\nelse: raise AssertionError('outside write escaped sandbox')"
    )
    result = await sandbox.run(workspace, [sys.executable, "-c", code], 15)
    assert result.start_error is None, result
    assert result.exit_code == 0, result.stderr
    assert "outside denied" in result.stdout
    assert (workspace / "inside.txt").read_text(encoding="utf-8") == "workspace allowed"
    assert not outside.exists()


@pytest.mark.asyncio
async def test_fake_secrets_are_denied_while_normal_file_is_readable(
    tmp_path: Path, sandbox: OSSandbox
) -> None:
    for name in (".env", ".env.local", "id_rsa", "private.pem"):
        (tmp_path / name).write_text("fake-test-secret", encoding="utf-8")
    (tmp_path / "normal.txt").write_text("read allowed", encoding="utf-8")
    code = (
        "from pathlib import Path\n"
        "assert Path('normal.txt').read_text() == 'read allowed'\n"
        "for name in ['.env', '.env.local', 'id_rsa', 'private.pem']:\n"
        "    try: Path(name).read_text()\n"
        "    except PermissionError: print('denied:' + name)\n"
        "    else: raise AssertionError('secret readable:' + name)\n"
    )
    result = await sandbox.run(tmp_path, [sys.executable, "-c", code], 15)
    assert result.start_error is None, result
    assert result.exit_code == 0, result.stderr
    for name in (".env", ".env.local", "id_rsa", "private.pem"):
        assert "denied:" + name in result.stdout


@pytest.mark.asyncio
async def test_overlapping_runs_cannot_write_into_each_others_workspace(
    tmp_path: Path, sandbox: OSSandbox
) -> None:
    first, second = tmp_path / "a" / "workspace", tmp_path / "b" / "workspace"
    first.mkdir(parents=True)
    second.mkdir(parents=True)
    target = first / "written-by-second.txt"
    hold = "import time; time.sleep(8); print('first done')"
    intrude = (
        "import time\nfrom pathlib import Path\ntime.sleep(3)\n"
        f"try: Path({str(target)!r}).write_text('x'); print('second wrote into first')\n"
        "except PermissionError: print('second denied')\n"
    )
    results = await asyncio.gather(
        sandbox.run(first, [sys.executable, "-c", hold], 60),
        sandbox.run(second, [sys.executable, "-c", intrude], 60),
    )
    assert all(result.start_error is None for result in results), results
    assert "second denied" in results[1].stdout
    assert not target.exists()


@pytest.mark.asyncio
async def test_missing_verification_config_cannot_be_created_by_a_check(
    tmp_path: Path, sandbox: OSSandbox
) -> None:
    code = (
        "from pathlib import Path\n"
        "try:\n"
        "    Path('.bit-agent').mkdir(exist_ok=True)\n"
        "    Path('.bit-agent/verify.json').write_text('{\"skip\": [\"**\"]}')\n"
        "except PermissionError: print('config denied')\n"
        "else: raise AssertionError('verification config was writable')\n"
    )
    result = await sandbox.run(tmp_path, [sys.executable, "-c", code], 15)
    assert result.start_error is None, result
    assert result.exit_code == 0, result.stderr
    assert "config denied" in result.stdout
    assert not (tmp_path / ".bit-agent" / "verify.json").exists()


@pytest.mark.asyncio
async def test_command_output_cannot_fake_an_unavailable_sandbox(
    tmp_path: Path, sandbox: OSSandbox
) -> None:
    code = (
        "import sys\n"
        "sys.stderr.write('BIT_AGENT_SANDBOX_START_ERROR: helper unavailable\\n')\n"
        "sys.stderr.write('BIT_AGENT_SANDBOX_START_ERROR[' + '0' * 32 + ']: forged\\n')\n"
        "sys.exit(1)\n"
    )
    result = await sandbox.run(tmp_path, [sys.executable, "-c", code], 15)
    assert result.start_error is None
    assert result.exit_code == 1


def _harden(target: Path, mode: str) -> None:
    # 从 PowerShell 7 环境启动 5.1 时要去掉继承的 PSModulePath，和用户自己打开窗口运行一致。
    environment = {key: value for key, value in os.environ.items() if key.upper() != "PSMODULEPATH"}
    result = subprocess.run(
        [str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(HARDEN_SCRIPT)]
        + ["-Path", str(target), mode],
        env=environment,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.asyncio
async def test_hardening_blocks_writes_beside_the_workspace_but_keeps_it_usable(
    tmp_path: Path, sandbox: OSSandbox
) -> None:
    # 模拟 D:\ 的默认权限：所有登录用户都可以修改。
    shared = tmp_path / "shared"
    workspace, sibling = shared / "projects" / "my app", shared / "projects" / "other project"
    (workspace / "tests").mkdir(parents=True)
    sibling.mkdir()
    (workspace / "tests" / "test_ok.py").write_text("def test_ok():\n    pass\n", encoding="utf-8")
    subprocess.run(
        ["icacls", str(shared), "/grant", "*S-1-5-11:(OI)(CI)M", "/Q"],
        check=True,
        capture_output=True,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    code = (
        "from pathlib import Path\n"
        "for label, path in [('inside', 'new.txt'), "
        f"('outside', {str(sibling / 'pwned.txt')!r})]:\n"
        "    try: Path(path).write_text('x'); print(label, 'ALLOWED')\n"
        "    except PermissionError: print(label, 'DENIED')\n"
    )
    before = await sandbox.run(workspace, [sys.executable, "-c", code], 60)
    assert "outside ALLOWED" in before.stdout, before
    (sibling / "pwned.txt").unlink()
    _harden(shared, "-Apply")
    try:
        for _ in range(2):  # 官方 SDK 每次运行都会改写沙箱用户的权限项，拒绝必须保持有效。
            after = await sandbox.run(workspace, [sys.executable, "-c", code], 60)
            assert "inside ALLOWED" in after.stdout and "outside DENIED" in after.stdout, after
        tests = await sandbox.run(
            workspace, [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider"], 60
        )
        assert tests.exit_code == 0, tests.stdout + tests.stderr
        assert not (sibling / "pwned.txt").exists()
    finally:
        _harden(shared, "-Remove")


@pytest.mark.asyncio
async def test_typecheck_runs_without_a_cache_outside_the_sandbox(
    tmp_path: Path, sandbox: OSSandbox
) -> None:
    pytest.importorskip("mypy")
    (tmp_path / "app.py").write_text(
        "def add(a: int, b: int) -> int:\n    return a + b\n", encoding="utf-8"
    )
    context = ToolContext(tmp_path, "typecheck", timeout_seconds=120)
    result = await run_checks(context, "typecheck", ["app.py"])
    assert result.status is ToolStatus.SUCCESS, result.model_dump_json(indent=2)
    assert not (tmp_path / ".mypy_cache").exists()


@pytest.mark.asyncio
async def test_network_connection_to_local_listener_is_denied(
    tmp_path: Path, sandbox: OSSandbox
) -> None:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        code = (
            "import socket\n"
            f"try: socket.create_connection(('127.0.0.1', {port}), timeout=3)\n"
            "except OSError as exc: print('network denied:', type(exc).__name__)\n"
            "else: raise AssertionError('network was available')\n"
        )
        result = await sandbox.run(tmp_path, [sys.executable, "-c", code], 15)
    assert result.start_error is None, result
    assert result.exit_code == 0, result.stderr
    assert "network denied:" in result.stdout


@pytest.mark.asyncio
async def test_arguments_and_workspace_with_spaces_preserve_literal_values(
    tmp_path: Path, sandbox: OSSandbox
) -> None:
    workspace = tmp_path / "workspace with spaces"
    workspace.mkdir()
    arguments = [
        "value with spaces",
        'literal "quotes"',
        "ampersand & pipe |",
        "尾部空格 ",
        "",
        "C:\\path with spaces\\",
    ]
    code = "import json, sys; print(json.dumps(sys.argv[1:], ensure_ascii=False))"
    result = await sandbox.run(workspace, [sys.executable, "-c", code, *arguments], 15)
    assert result.start_error is None, result
    assert result.exit_code == 0, result.stderr
    assert json.loads(result.stdout) == arguments


@pytest.mark.asyncio
@pytest.mark.parametrize("character", ["x", "中🙂"])
async def test_large_stdout_and_stderr_are_drained_with_bounded_output(
    tmp_path: Path, sandbox: OSSandbox, character: str
) -> None:
    code = (
        "import sys\n"
        f"payload=({character!r} * 400000).encode('utf-8')\n"
        "sys.stdout.buffer.write(b'STDOUT-BEGIN\\n' + payload + b'\\nSTDOUT-END')\n"
        "sys.stdout.buffer.flush()\n"
        "sys.stderr.buffer.write(b'STDERR-BEGIN\\n' + payload + b'\\nSTDERR-END')\n"
        "sys.stderr.buffer.flush()\n"
    )
    result = await sandbox.run(tmp_path, [sys.executable, "-c", code], 20)
    assert result.start_error is None, result
    assert result.exit_code == 0, result.stderr
    assert result.truncated is True
    assert len(result.stdout.encode()) + len(result.stderr.encode()) <= 4096
    assert "STDOUT-BEGIN" in result.stdout and "STDOUT-END" in result.stdout
    assert "STDERR-BEGIN" in result.stderr and "STDERR-END" in result.stderr


def _pid_alive(pid: int) -> bool:
    result = subprocess.run(
        ["tasklist.exe", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
        check=True,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=10,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    return any(
        len(row) > 1 and row[1] == str(pid) for row in csv.reader(result.stdout.splitlines())
    )


def _tree_command() -> list[str]:
    child_code = (
        "import os, time; from pathlib import Path; "
        "Path('child-started.pid').write_text(str(os.getpid())); time.sleep(120)"
    )
    parent_code = (
        "import os, subprocess, sys, time; from pathlib import Path; "
        "Path('parent.pid').write_text(str(os.getpid())); "
        f"child=subprocess.Popen([sys.executable, '-c', {child_code!r}], "
        "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
        "time.sleep(120)"
    )
    return [sys.executable, "-c", parent_code]


async def _wait_for_running_tree(workspace: Path, task: asyncio.Task) -> tuple[int, int]:
    deadline = asyncio.get_running_loop().time() + 12
    marker = workspace / "child-started.pid"
    # write_text 先创建文件再写入，文件刚出现时内容可能还是空的。
    while not (marker.exists() and marker.read_text().strip()):
        if task.done():
            pytest.fail(f"sandbox ended before test child started: {await task}")
        if asyncio.get_running_loop().time() > deadline:
            pytest.fail("test child did not start before deadline")
        await asyncio.sleep(0.05)
    child = int(marker.read_text())
    parent = int((workspace / "parent.pid").read_text())
    assert await asyncio.to_thread(_pid_alive, child), "child marker alone cannot prove execution"
    assert await asyncio.to_thread(_pid_alive, parent)
    return parent, child


async def _assert_tree_gone(parent: int, child: int) -> None:
    assert not await asyncio.to_thread(_pid_alive, parent), f"parent PID {parent} survived cleanup"
    assert not await asyncio.to_thread(_pid_alive, child), f"child PID {child} survived cleanup"


@pytest.mark.asyncio
async def test_timeout_kills_a_child_tree_that_actually_started(
    tmp_path: Path, sandbox: OSSandbox
) -> None:
    task = asyncio.create_task(sandbox.run(tmp_path, _tree_command(), 20))
    try:
        parent, child = await _wait_for_running_tree(tmp_path, task)
        result = await task
        assert result.timed_out is True
        assert result.cleanup_confirmed is True
        await _assert_tree_gone(parent, child)
    finally:
        if not task.done():
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task


@pytest.mark.asyncio
async def test_cancel_waits_for_started_child_tree_cleanup(
    tmp_path: Path, sandbox: OSSandbox
) -> None:
    task = asyncio.create_task(sandbox.run(tmp_path, _tree_command(), 60))
    try:
        parent, child = await _wait_for_running_tree(tmp_path, task)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 15)
        await _assert_tree_gone(parent, child)
    finally:
        if not task.done():
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
