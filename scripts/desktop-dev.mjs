// 开发时一条命令启动界面和 Gateway；Gateway 再启动本地 Python 执行进程。
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const env = { ...process.env, BIT_AGENT_PROJECT_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
const gateway = spawn(process.execPath, [
  join(root, "apps/gateway/node_modules/tsx/dist/cli.mjs"),
  join(root, "apps/gateway/src/index.ts"),
], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
let desktop;
let stopped = false;
let startupOutput = "";
const timeout = setTimeout(() => {
  console.error("Gateway 启动超时，请检查上方错误、Python 环境和端口占用。");
  stop(1);
}, 40_000);

function stop(code = 0) {
  if (stopped) return;
  stopped = true;
  clearTimeout(timeout);
  process.exitCode = code;
  desktop?.kill();
  gateway.kill();
}

gateway.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  startupOutput = (startupOutput + chunk.toString()).slice(-8000);
  if (!desktop && !stopped && startupOutput.includes("Bit Agent Gateway started")) {
    clearTimeout(timeout);
    desktop = spawn(process.execPath, [
      join(root, "apps/desktop/node_modules/electron/cli.js"), join(root, "apps/desktop"),
    ], { cwd: root, env, windowsHide: true, stdio: "inherit" });
    desktop.once("error", (error) => { console.error(error); stop(1); });
    desktop.once("exit", (code) => stop(code ?? 0));
  }
});
gateway.once("error", (error) => { console.error(error); stop(1); });
gateway.once("exit", (code) => {
  if (!stopped) {
    console.error("Gateway 已退出，桌面启动流程结束。");
    stop(code || 1);
  }
});
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
