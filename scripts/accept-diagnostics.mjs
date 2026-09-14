// Real packaged Electron + Gateway + Python; provider and save dialog are controlled fixtures.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as socketServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "packages/diagnostics/package.json"));
const AdmZip = require("adm-zip");
const executable = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Pass packaged exe path");
const directory = mkdtempSync(join(root, "tmp", "diagnostics-desktop-"));
console.log("ACCEPTANCE_DIRECTORY", directory);
const workspace = join(directory, "workspace"); mkdirSync(workspace);
const destination = join(directory, "diagnostics.zip");
const held = new Set();
const model = createServer(async (request, response) => {
  let body = ""; for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  if (input.model === "error-fixture") {
    response.writeHead(401, { "content-type": "application/json", "x-request-id": "fixture-error-401" });
    response.end(JSON.stringify({ error: { code: "invalid_api_key", message: "SECRET-FIXTURE-KEY PRIVATE-PROMPT" } }));
    return;
  }
  const complete = { id: "resp_fixture", object: "response", created_at: 1, status: "in_progress", model: input.model, output: [] };
  response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "fixture-stream-200" });
  response.write(`data: ${JSON.stringify({ type: "response.created", response: complete })}\n\n`);
  if (input.model === "broken-stream") setTimeout(() => response.destroy(), 80);
  else { held.add(response); response.on("close", () => held.delete(response)); }
});
await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
const debug = socketServer(); await new Promise(resolve => debug.listen(0, "127.0.0.1", resolve));
const port = debug.address().port; await new Promise(resolve => debug.close(resolve));
const env = { ...process.env, BIT_AGENT_DESKTOP_USER_DATA: join(directory, "profile"),
  BIT_AGENT_DATA_DIR: join(directory, "data"), BIT_AGENT_ACCEPTANCE_HIDDEN: "1",
  BIT_AGENT_TASK_TIMEOUT_SECONDS: "30", BIT_AGENT_STREAMING: "1" };
for (const key of ["ELECTRON_RUN_AS_NODE", "API_KEY", "BASE_URL", "MODEL_NAME", "BIT_AGENT_LOG_DIR"]) delete env[key];
const child = spawn(executable, [`--remote-debugging-port=${port}`, "--inspect=127.0.0.1:0", "--disable-gpu",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding"], {
  cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
let inspector = ""; let stderr = "";
child.stderr.on("data", chunk => { stderr += String(chunk); inspector = stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/u)?.[1] ?? ""; });
child.stdout.resume();
const connections = [];
async function until(operation, label, attempts = 150) {
  for (let i = 0; i < attempts; i++) {
    const result = await operation().catch(() => false); if (result) return result;
    if (child.exitCode !== null) throw new Error(`App exited ${child.exitCode}: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
async function connect(url) {
  const ws = new WebSocket(url); connections.push(ws);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP connection timeout")), 5000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once:true });
    ws.addEventListener("error", error => { clearTimeout(timer); reject(error); }, { once:true });
  });
  const pending = new Map(); let sequence = 0;
  ws.addEventListener("message", ({data}) => { const item = JSON.parse(data); if (pending.has(item.id)) { pending.get(item.id)(item); pending.delete(item.id); } });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 15000);
    pending.set(id, item => { clearTimeout(timer); item.error ? reject(new Error(JSON.stringify(item.error))) : resolve(item.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const value = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
  };
  return { command, evaluate };
}
let page;
try {
  const tab = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })).json())
    .find(t => t.type === "page" && t.url.includes("index.html")), "renderer ready");
  page = await connect(tab.webSocketDebuggerUrl);
  console.log("RENDERER_CONNECTED");
  await until(() => page.evaluate("Boolean(window.bitAgent && document.querySelector('#diagnostics-settings'))"), "UI ready");
  const main = await connect(await until(async () => inspector, "main inspector"));
  console.log("MAIN_CONNECTED");
  await main.evaluate(`globalThis.fixtureElectron = process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app/package.json')('electron'); fixtureElectron.dialog.showSaveDialog = async () => ({canceled:false,filePath:${JSON.stringify(destination)}}); true`);
  const gatewayUrl = (await page.evaluate("window.bitAgent.runtimeConfig")).gatewayUrl;
  assert.ok(gatewayUrl);
  const configure = modelName => page.evaluate(`window.bitAgent.saveModelSettings(${JSON.stringify({ model:modelName,
    baseUrl:`http://127.0.0.1:${model.address().port}/v1`, apiKey:"SECRET-FIXTURE-KEY" })})`);
  const start = () => page.evaluate(`window.bitAgent.createTask(${JSON.stringify({ gatewayUrl, workspaceRoot:workspace,
    objective:"PRIVATE-PROMPT", multiAgentMode:"off", permissionMode:"read_only" })})`);
  const request = taskId => JSON.stringify({gatewayUrl, taskId});
  const finished = taskId => until(async () => {
    const task = await page.evaluate(`window.bitAgent.getTask(${request(taskId)})`);
    return ["FAILED", "CANCELLED"].includes(task.status) && task;
  }, "terminal task");
  await configure("error-fixture");
  console.log("MODEL_CONFIGURED");
  const errorTask = await start(); const errorResult = await finished(errorTask.task_id);
  assert.match(errorResult.error, /D-[a-f0-9]{16}/u);
  assert.ok(!errorResult.error.includes("SECRET"));
  await configure("broken-stream");
  const broken = await start(); assert.equal((await finished(broken.task_id)).status, "FAILED");
  await configure("hold-stream"); const waiting = await start();
  await until(async () => {
    const status = await page.evaluate(`window.bitAgent.diagnosticStatus(${request(waiting.task_id)})`);
    return status.tasks?.[0]?.phase === "model";
  }, "model wait phase");
  await page.evaluate(`window.bitAgent.cancelTask(${request(waiting.task_id)})`);
  assert.equal((await finished(waiting.task_id)).status, "CANCELLED");
  await page.evaluate("document.querySelector('#diagnostics-settings').click()");
  await until(() => page.evaluate("document.querySelector('.product-dialog-body')?.getAttribute('aria-busy') === 'false'"), "diagnostic UI");
  const geometry = await page.evaluate(`(() => {const d=document.querySelector('.product-dialog[open]');const r=d.getBoundingClientRect();return {width:r.width,height:r.height,overflow:d.scrollWidth-d.clientWidth,text:d.innerText};})()`);
  assert.ok(geometry.text.includes("导出脱敏诊断包"));
  assert.ok(geometry.overflow <= 1);
  let screenshot = false;
  try {
    const data = await main.evaluate(`(async () => { const w=fixtureElectron.BrowserWindow.getAllWindows()[0]; w.webContents.setBackgroundThrottling(false); w.showInactive(); await new Promise(r=>setTimeout(r,300)); const image=await w.webContents.capturePage(undefined,{stayAwake:true}); w.hide(); return image.toPNG().toString('base64'); })()`);
    if (data) { writeFileSync(join(directory, "diagnostics.png"), Buffer.from(data, "base64")); screenshot = true; }
  } catch { /* Visible-desktop validation is reported separately from automated execution. */ }
  await page.evaluate("document.querySelector('#export-diagnostics').click()");
  await until(async () => existsSync(destination), "export zip", 400);
  const zip = new AdmZip(readFileSync(destination));
  const contents = zip.getEntries().map(e => zip.readAsText(e)).join("\n");
  assert.ok(contents.includes("model_http_response"));
  assert.ok(contents.includes("fixture-error-401"));
  assert.ok(contents.includes("model_stream_failed"));
  for (const secret of ["SECRET-FIXTURE-KEY", "PRIVATE-PROMPT"]) assert.ok(!contents.includes(secret));
  const report = { executable, directory, httpError: true, streamInterrupted: true, waitPhase: true,
    cancel: true, uiOpened: true, exportViaIPC: true, redacted: true, screenshot,
    nativeSaveDialog: "stubbed", realProvider: false };
  writeFileSync(join(directory, "acceptance.json"), JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally {
  if (page && child.exitCode === null) {
    await page.evaluate("window.close()").catch(() => {});
    for (const connection of connections) connection.close();
    await new Promise(resolve => { const timer=setTimeout(() => {child.kill();resolve();},10000); child.once("exit",()=>{clearTimeout(timer);resolve();}); });
  } else { for (const connection of connections) connection.close(); if(child.exitCode===null) child.kill(); }
  for (const response of held) response.destroy();
  model.closeAllConnections(); await new Promise(resolve=>model.close(resolve));
}
