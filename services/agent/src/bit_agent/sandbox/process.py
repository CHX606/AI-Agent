"""Manage the official sandbox broker, graceful cleanup, and child tree."""

import asyncio
import subprocess

from .output import OutputBuffer, drain


async def terminate_tree(process) -> bool:
    if process.returncode is not None:
        return True
    killer = await asyncio.create_subprocess_exec(
        "taskkill.exe",
        "/PID",
        str(process.pid),
        "/T",
        "/F",
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    await killer.wait()
    try:
        await asyncio.wait_for(process.wait(), 10)
    except TimeoutError:
        process.kill()
        await process.wait()
        return False
    return killer.returncode == 0


async def close_broker(process) -> bool:
    if process.returncode is not None:
        return True
    if process.stdin is not None:
        process.stdin.close()
    try:
        await asyncio.wait_for(process.wait(), 10)
        return process.returncode in {0, 125, 130}
    except TimeoutError:
        await terminate_tree(process)
        return False


async def execute(arguments: list[str], root, env: dict, timeout: float, limit: int) -> dict:
    process = await asyncio.create_subprocess_exec(
        *arguments,
        cwd=root,
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    stdout, stderr = OutputBuffer(limit // 2), OutputBuffer(limit - limit // 2)
    readers = [
        asyncio.create_task(drain(process.stdout, stdout)),
        asyncio.create_task(drain(process.stderr, stderr)),
    ]
    timed_out, cleanup = False, None
    try:
        await asyncio.wait_for(process.wait(), timeout)
    except TimeoutError:
        timed_out, cleanup = True, await close_broker(process)
    except asyncio.CancelledError:
        await close_broker(process)
        await asyncio.gather(*readers)
        raise
    if process.stdin is not None:
        process.stdin.close()
    await asyncio.gather(*readers)
    out, out_truncated = stdout.render()
    err, err_truncated = stderr.render()
    return dict(
        exit_code=process.returncode,
        stdout=out,
        stderr=err,
        timed_out=timed_out,
        cleanup_confirmed=cleanup,
        truncated=out_truncated or err_truncated,
    )
