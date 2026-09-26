import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

import { buildApp } from "./bootstrap.js";
import { LocalTaskStore } from "./infrastructure/runtime/local-task-store.js";
import { gatewayDiagnostics } from "./infrastructure/observability/diagnostics.js";

for (const candidate of [resolve(".env"), resolve("..", "..", ".env")]) {
  if (existsSync(candidate)) {
    loadEnvFile(candidate);
    break;
  }
}

// 只启动一个本机 Python 进程；任务和会话由它保存在 SQLite 中。
const taskStore = await LocalTaskStore.connect();
const app = buildApp({ taskStore });

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await taskStore.close();
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
  await taskStore.close();
  await gatewayDiagnostics.close();
  process.exit(1);
}
