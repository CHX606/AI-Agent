import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

import { buildApp } from "./bootstrap.js";
import { LocalTaskStore } from "./infrastructure/runtime/local-task-store.js";
import type { TaskStore } from "./application/ports/task-store.js";
import { gatewayDiagnostics } from "./infrastructure/observability/diagnostics.js";

for (const candidate of [resolve(".env"), resolve("..", "..", ".env")]) {
  if (existsSync(candidate)) {
    loadEnvFile(candidate);
    break;
  }
}

// 默认只启动一个本机 Python 进程。旧 Redis 链路必须显式选择，旧数据不会被删除。
let taskStore: TaskStore;
const backend = process.env.BIT_AGENT_RUNTIME ?? "local";
if (backend === "redis") {
  const { RedisTaskStore } = await import("./infrastructure/persistence/redis-task-store.js");
  taskStore = await RedisTaskStore.connect(process.env.BIT_AGENT_REDIS_URL ?? "redis://127.0.0.1:6379/0");
} else if (backend === "local") {
  taskStore = await LocalTaskStore.connect();
} else {
  throw new Error("BIT_AGENT_RUNTIME 只能是 local 或 redis");
}
const app = buildApp({ taskStore });

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await taskStore.close?.();
  await app.close();
  await gatewayDiagnostics.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  const address = await app.listen({ host, port });
  app.log.info({ address }, "Bit Agent Gateway started");
} catch (error) {
  gatewayDiagnostics.failure("gateway_startup_failed", error);
  await taskStore.close?.();
  await gatewayDiagnostics.close();
  process.exit(1);
}
