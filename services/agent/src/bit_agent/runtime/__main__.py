"""通过进程输入输出接收 Gateway 请求。标准输出只放协议消息，日志走标准错误。"""

import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from bit_agent.observability.diagnostics import configure_logging, failure, record
from bit_agent.runtime.application.ports import DiagnosticSnapshotPort
from bit_agent.runtime.bootstrap import create_runtime
from bit_agent.runtime.infrastructure.storage import default_data_directory
from bit_agent.runtime.transport.rpc import JsonLineRpcServer


async def main() -> None:
    load_dotenv()
    output = sys.stdout
    sys.stdout = sys.stderr
    directory = default_data_directory()
    configure_logging(Path(os.getenv("BIT_AGENT_LOG_DIR", str(directory / "logs"))))
    sys.excepthook = lambda kind, error, tb: failure("process_uncaught", error)
    asyncio.get_running_loop().set_exception_handler(
        lambda loop, context: failure("async_unhandled", context.get("exception") or RuntimeError())
    )
    record("info", "runtime_starting")
    directory.mkdir(parents=True, exist_ok=True)
    # 同一个数据库只由一个运行服务管理，避免两个服务错误恢复对方正在执行的任务。
    lock_file = (directory / "runtime.lock").open("a+b")
    lock_file.seek(0)
    lock_file.write(b"0")
    lock_file.flush()
    lock_file.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    runtime = create_runtime(directory)
    await runtime.start()
    diagnostics: DiagnosticSnapshotPort = runtime
    methods = {
        "diagnostic_snapshot": diagnostics.diagnostic_snapshot,
        "create_task": runtime.create_task,
        "get_task": runtime.get_task,
        "cancel_task": runtime.cancel_task,
        "interact_task": runtime.interact_task,
        "get_changes": runtime.get_changes,
        "review_change": runtime.review_change,
        "configure_model": runtime.configure_model,
        "read_events": runtime.read_events,
        "list_sessions": runtime.list_sessions,
        "get_session": runtime.get_session,
        "set_mode": runtime.set_mode,
    }

    async def health():
        return {"status": "ok", "storage": "sqlite", "data_directory": str(directory)}

    methods["health"] = health
    server = JsonLineRpcServer(methods, output)
    record("info", "runtime_ready")
    try:
        await server.serve(sys.stdin)
    finally:
        await runtime.close()
        lock_file.close()
        record("info", "runtime_stopped")


if __name__ == "__main__":
    asyncio.run(main())
