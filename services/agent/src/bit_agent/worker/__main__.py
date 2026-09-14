"""使用 ``python -m bit_agent.worker`` 启动 Worker。"""

import asyncio
import os
import socket
from uuid import uuid4

from dotenv import load_dotenv

from bit_agent.worker import AgentWorker, RedisTaskBroker


async def main() -> None:
    load_dotenv()
    redis_url = os.getenv("BIT_AGENT_REDIS_URL", "redis://127.0.0.1:6379/0")
    worker_id = os.getenv("BIT_AGENT_WORKER_ID") or f"{socket.gethostname()}-{uuid4().hex[:8]}"
    timeout = float(os.getenv("BIT_AGENT_TASK_TIMEOUT_SECONDS", "3600"))
    broker = RedisTaskBroker.from_url(redis_url)
    worker = AgentWorker(broker, worker_id=worker_id, task_timeout_seconds=timeout)
    try:
        print(f"Bit Agent Worker started: {worker_id}")
        await worker.run_forever()
    finally:
        await broker.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
