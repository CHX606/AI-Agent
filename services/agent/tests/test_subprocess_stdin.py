"""运行服务的标准输入是 RPC 管道。子进程继承它时，Windows 上进程创建会卡到下一条请求，
所以每个子进程都必须显式指定 stdin。"""

import ast
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parents[1] / "src" / "bit_agent"


def test_every_async_subprocess_sets_stdin():
    missing = []
    for path in SOURCE.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "create_subprocess_exec"
                and not any(keyword.arg == "stdin" for keyword in node.keywords)
            ):
                missing.append(f"{path.relative_to(SOURCE)}:{node.lineno}")
    assert missing == [], "这些子进程会继承 RPC 管道：" + "、".join(missing)


@pytest.mark.skipif(
    sys.platform != "win32" or shutil.which("node") is None,
    reason="需要 Windows 和 Node：Gateway 用 Node 创建的管道才会触发这个问题",
)
def test_git_does_not_wait_for_rpc_input(tmp_path):
    """像 Gateway 一样用 Node 启动 Python，Python 一个线程阻塞读取标准输入，同时启动 Git。"""
    python = textwrap.dedent(
        """
        import asyncio, os, sys
        from pathlib import Path
        from bit_agent.runtime.infrastructure.git import _git

        async def main():
            asyncio.ensure_future(asyncio.to_thread(sys.stdin.readline))
            await asyncio.sleep(0.3)
            print((await _git(Path(sys.argv[1]), "--version"))[0], flush=True)
            # 读取标准输入的线程不会自己结束，直接退出，不等它。
            os._exit(0)

        asyncio.run(main())
        """
    )
    # 父进程（Node）始终不写入标准输入；修复前子进程会一直卡在启动 Git。
    node = textwrap.dedent(
        """
        const { spawn } = require("node:child_process");
        const [python, script, root] = process.argv.slice(1);
        const stdio = ["pipe", "inherit", "inherit"];
        const child = spawn(python, ["-c", script, root], { stdio });
        const timer = setTimeout(() => { child.kill(); process.exit(3); }, 15000);
        child.on("exit", (code) => { clearTimeout(timer); process.exit(code ?? 1); });
        """
    )
    completed = subprocess.run(
        ["node", "-e", node, sys.executable, python, str(tmp_path)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert completed.returncode != 3, "启动 Git 时被继承的标准输入管道卡住"
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == "0"
