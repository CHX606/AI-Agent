import { fileURLToPath } from "node:url";
import { runSandbox } from "./sandbox-runner/lifecycle.js";
import { brokerErrorMarker } from "./sandbox-runner/marker.js";
import { brokerStatus } from "./sandbox-runner/status.js";
import { parseSandboxRequest } from "./sandbox-runner/request.js";

async function main(): Promise<void> {
  if (process.argv[2] === "--status") {
    process.stdout.write(JSON.stringify(await brokerStatus()) + "\n");
    return;
  }
  const marker = brokerErrorMarker(process.argv[3]);
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Sandbox operation was cancelled"));
  process.stdin.resume();
  process.stdin.once("end", abort);
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    const request = parseSandboxRequest(process.argv[2]);
    process.exitCode = await runSandbox(request, fileURLToPath(import.meta.url), controller.signal);
  } catch (error) {
    process.stderr.write("\n" + marker + String(error) + "\n");
    process.exitCode = 125;
  } finally {
    process.stdin.removeListener("end", abort);
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
    process.stdin.pause();
  }
}

void main();
