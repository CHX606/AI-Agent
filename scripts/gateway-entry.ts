import { buildApp } from "../apps/gateway/src/bootstrap.js";
import { LocalTaskStore } from "../apps/gateway/src/infrastructure/runtime/local-task-store.js";
import { gatewayDiagnostics } from "../apps/gateway/src/infrastructure/observability/diagnostics.js";

const store = await LocalTaskStore.connect();
const gateway = buildApp({ taskStore: store });
const gatewayUrl = await gateway.listen({ host: "127.0.0.1", port: 0 });
process.stdout.write(JSON.stringify({ gatewayUrl }) + "\n");
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await store.close();
  await gateway.close();
  await gatewayDiagnostics.close();
  process.exit(0);
}
process.stdin.resume();
process.stdin.on("end", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
