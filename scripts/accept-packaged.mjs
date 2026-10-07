// 启动发布目录中的真正 exe。浏览器调试端口仅由本验收进程临时启用。
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { verifyConversationLayout, verifyFoldedPatch, verifyNoEmptyText, verifySidebarOrder } from "../apps/desktop/test/stream-sidebar-packaged.mjs";
import { markdownFixture, verifyCopy, verifyMarkdown } from "../apps/desktop/test/markdown-packaged.mjs";
import { verifyRewind } from "../apps/desktop/test/rewind-packaged.mjs";
import { verifySidebarCollapse, verifySidebarResize, verifyWorkspaceOrder } from "../apps/desktop/test/workspace-sidebar-packaged.mjs";
import { verifyTerminal } from "../apps/desktop/test/terminal-packaged.mjs";
import { verifyZoomControls } from "../apps/desktop/test/zoom-controls-packaged.mjs";
import { verifyBrowser, verifyBrowserAgent, verifyBrowserFullscreen } from "../apps/desktop/test/browser-packaged.mjs";
import { auditLayouts } from "../apps/desktop/test/layout-audit-packaged.mjs";
import { evaluateMain, verifyImageInput } from "../apps/desktop/test/image-input-packaged.mjs";
import { verifyFileAttachments } from "../apps/desktop/test/attachment-input-packaged.mjs";

const executable = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("需要提供待验收的 exe 路径");
const root = resolve(import.meta.dirname, "..");
const directory = mkdtempSync(join(root, "tmp", "packaged-acceptance-"));
console.log("PACKAGED_ACCEPTANCE_DIRECTORY", directory);
const workspace = join(directory, "workspace"); mkdirSync(workspace);
const otherWorkspace = join(directory, "workspace-b"); mkdirSync(otherWorkspace);
writeFileSync(join(otherWorkspace, "README.md"), "second workspace\n");
// 验收工作区是一个 Git 仓库，用来检查“提交到 Git”。本地配置避免依赖用户的全局 Git 设置。
const gitSetup = (...args) => {
  const result = spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};
gitSetup("init", "-q", "-b", "main");
gitSetup("config", "user.name", "Package Acceptance");
gitSetup("config", "user.email", "package@example.com");
gitSetup("config", "commit.gpgsign", "false");
writeFileSync(join(workspace, "README.md"), "acceptance\n");
gitSetup("add", "README.md");
gitSetup("commit", "-q", "-m", "initial");
const requests = [];
const probes = [];
const responseGates = new Map();
function releaseResponse(goal) { responseGates.get(goal)?.(); responseGates.delete(goal); }
const model = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/markdown-image.svg") {
    response.writeHead(200, { "content-type":"image/svg+xml" });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40"><rect width="160" height="40" fill="#df7440"/><text x="8" y="25" fill="white">Markdown image</text></svg>');
    return;
  }
  if (request.method === "GET" && request.url === "/browser-fixture") {
    // Agent 操控浏览器的测试页：一个搜索框，提交后改标题并在控制台报一条错误。
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<title>Agent Fixture</title><body><h1>Agent fixture</h1>
      <form id="f"><label>Search <input name="q"></label> <button>Go</button></form>
      <script>document.getElementById('f').addEventListener('submit', (event) => { event.preventDefault();
        const value = event.target.q.value; document.title = 'Agent Done: ' + value; console.error('agent-console-error ' + value);
        document.body.append('submitted ' + value); });</script></body>`);
    return;
  }
  if (request.method === "GET" && request.url?.endsWith("/models")) {
    // “从服务获取”：向量模型应被过滤掉。
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: ["local-fixture", "local-fixture-mini", "text-embedding-3-small"].map((id) => ({ id, object: "model" })) }));
    return;
  }
  if (request.method === "GET") {
    // 其他 GET（例如浏览器自动请求的 /favicon.ico）不是模型请求。
    response.writeHead(404).end();
    return;
  }
  let raw = ""; for await (const chunk of request) raw += String(chunk);
  const body = JSON.parse(raw);
  if (body.input === "ping") {
    // “测试连接”：不流式的极小请求，带一个占位工具定义。
    probes.push({ path: request.url, tools: body.tools?.map((tool) => tool.name) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "probe", object: "response", created_at: 1, status: "completed", model: body.model,
      output: [{ type: "message", id: "probe-msg", status: "completed", role: "assistant",
        content: [{ type: "output_text", text: "pong", annotations: [] }] }] }));
    return;
  }
  requests.push(body);
  const users = body.input.filter((item) => item.role === "user").map((item) =>
    Array.isArray(item.content) ? item.content.filter(block=>block.type==='input_text').map(block=>block.text).join('\n') : String(item.content));
  const held = ["QUEUE-TEST", "STOP-QUEUE"].includes(users.at(-1))
    ? new Promise(done => responseGates.set(users.at(-1), done)) : null;
  const text = users.at(-1) === "PACKAGE-MARKDOWN"
    ? markdownFixture(`http://127.0.0.1:${model.address().port}/markdown-image.svg`)
    : `PACKAGED_STREAM_START ${users.join(" | ")} PACKAGED_STREAM_END`;
  const id = `resp-${requests.length}`;
  const message = { type: "message", id: `msg-${requests.length}`, status: "completed", role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }] };
    let output = [message];
  if (users.at(-1) === "PACKAGE-MCP") {
    const called = body.input.some(item => item.type === "function_call_output" && item.call_id === "package-mcp");
    const offered = (body.tools ?? []).some((tool) => tool.name === "mcp__self__list_files");
    output = called || !offered
      ? [{ ...message, content: [{ type: "output_text", text: offered ? "PACKAGE-MCP-DONE" : "MCP-TOOL-MISSING", annotations: [] }] }]
      : [{ type: "function_call", call_id: "package-mcp", name: "mcp__self__list_files", arguments: JSON.stringify({ path: "", max_depth: 0 }) }];
  }
  if (users.at(-1) === "PACKAGE-BROWSER") {
    // Agent 依次：打开测试页 → 读页面 → 在搜索框输入并提交 → 读控制台错误 → 截图 → 回答。
    const outputs = Object.fromEntries(body.input.filter(item => item.type === "function_call_output")
      .map(item => [item.call_id, (() => { try { return JSON.parse(item.output); } catch { return {}; } })()]));
    const call = (id, name, args) => [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }];
    const offered = (body.tools ?? []).some((tool) => tool.name === "mcp__browser__open");
    const snapshotText = String(outputs["browser-snapshot"]?.output ?? "");
    const searchRef = Number(snapshotText.match(/\[(\d+)\] textbox "Search"/u)?.[1] ?? 0);
    output = !offered ? [{ ...message, content: [{ type: "output_text", text: "BROWSER-TOOLS-MISSING", annotations: [] }] }]
      : !outputs["browser-open"] ? call("browser-open", "mcp__browser__open", { url: `http://127.0.0.1:${model.address().port}/browser-fixture` })
      : !outputs["browser-snapshot"] ? call("browser-snapshot", "mcp__browser__snapshot", {})
      : !outputs["browser-type"] ? call("browser-type", "mcp__browser__type", { ref: searchRef, text: "hello", clear: true, submit: true })
      : !outputs["browser-console"] ? call("browser-console", "mcp__browser__console", { level: "error" })
      : !outputs["browser-screenshot"] ? call("browser-screenshot", "mcp__browser__screenshot", {})
      : [{ ...message, content: [{ type: "output_text", text: "PACKAGE-BROWSER-DONE", annotations: [] }] }];
  }
  if (users.at(-1) === "PACKAGE-GROUP") {
    // 一次回复里查看目录、读两个文件：界面应合成一行可展开的分组。
    const done = body.input.some(item => item.type === "function_call_output" && item.call_id === "group-read-2");
    const call = (id, name, args) => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
    output = done ? [message] : [call("group-list", "list_files", { path: "", max_depth: 0 }),
      call("group-read-1", "read_file", { path: "README.md" }), call("group-read-2", "read_file", { path: "README.md" })];
  }
  if (users.at(-1) === "PACKAGE-EDIT") {
    const patched = body.input.some(item => item.type === "function_call_output" && item.call_id === "package-patch");
    output = patched
      ? [{ type: "function_call", call_id: "package-question", name: "ask_user", arguments: JSON.stringify({ question: "已写入测试文件，等待审阅", options: [{ id: "keep", label: "保留", description: "保留本次测试文件" }, { id: "stop", label: "停止", description: "结束验收任务" }], recommended_option_id: "stop", requires_confirmation: true, timeout_seconds: 60 }) }]
      : [{ type: "function_call", call_id: "package-patch", name: "apply_patch", arguments: JSON.stringify({ patch: "*** Begin Patch\n*** Add File: package-demo.py\n+print('package fixture')\n*** End Patch\n" }) }];
  }
  const complete = { id, object: "response", created_at: 1, status: "completed", model: "local-fixture", output };
  response.writeHead(200, { "content-type": "text/event-stream" });
  const event = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  event({ type: "response.created", response: { ...complete, status: "in_progress", output: [] } });
  await new Promise((done) => setTimeout(done, 120));
  if (output[0].type === "message") event({ type: "response.output_text.delta", delta: "PACKAGED_STREAM_START ", item_id: message.id, output_index: 0, content_index: 0 });
  if (held) await held;
  else await new Promise((done) => setTimeout(done, 1800));
  if (response.destroyed) return;
  if (output[0].type === "message") event({ type: "response.output_text.delta", delta: text.slice("PACKAGED_STREAM_START ".length), item_id: message.id, output_index: 0, content_index: 0 });
  event({ type: "response.completed", response: complete }); response.end();
});
await new Promise((done) => model.listen(0, "127.0.0.1", done));
const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;
let child;
let socket;
let mainInspectorUrl;
let diagnostic = "";
const layoutResults = [];
const check = async (operation, message, attempts = 250) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await operation().catch(() => false);
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`${message}\n${diagnostic.slice(-6000)}`);
};
async function chooseWorkspace(evaluate, workspaceRoot) {
  await evaluate(`(() => { const menu=document.querySelector('#workspace-chooser');menu.querySelector('.choice-trigger').click();const item=[...menu.querySelectorAll('.choice-item')].find(i=>i.dataset.value===${JSON.stringify(workspaceRoot)});if(!item) throw new Error('工作区菜单缺少指定目录');item.click(); })()`);
  assert.equal(await evaluate("document.querySelector('#workspace').value"), workspaceRoot);
}

async function verifyWorkspaceBinding(evaluate) {
  const sessionsBefore = (await evaluate("window.bitAgent.listSessions(window.bitAgent.runtimeConfig.gatewayUrl, 0)")).sessions;
  await evaluate(`localStorage.setItem('bit-agent.workspaces.v1',${JSON.stringify(JSON.stringify([workspace, otherWorkspace]))});document.querySelector('#nav-tasks').click();document.querySelector('#new-task').click()`);
  assert(await evaluate("document.querySelector('#workspace').value==='' && document.querySelector('#workspace-chooser .choice-value').textContent==='选择工作区'"), "普通新聊天隐式沿用了上一目录");
  await evaluate("document.querySelector('#objective').value='PACKAGE-WORKSPACE-A';document.querySelector('#objective').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#run').click()");
  assert(await evaluate("document.querySelector('#objective').value==='PACKAGE-WORKSPACE-A' && document.querySelector('#status').dataset.status==='ERROR'"), "未选目录时任务提交没有被阻止");
  assert.equal((await evaluate("window.bitAgent.listSessions(window.bitAgent.runtimeConfig.gatewayUrl, 0)")).sessions.length, sessionsBefore.length);
  const bindings = [];
  for (const [selected, objective] of [[workspace, "PACKAGE-WORKSPACE-A"], [otherWorkspace, "PACKAGE-WORKSPACE-B"]]) {
    await evaluate("document.querySelector('#new-task').click()");
    await chooseWorkspace(evaluate, selected);
    await evaluate(`document.querySelector('#objective').value=${JSON.stringify(objective)};document.querySelector('#objective').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#run').click()`);
    await check(() => evaluate(`document.querySelector('#status').dataset.status==='COMPLETED' && document.body.dataset.busy==='false' && document.querySelector('#objective-display').textContent===${JSON.stringify(objective)}`), "新工作区的对话没有完成");
    assert(await evaluate("document.querySelector('#workspace-chooser .choice-trigger').disabled"), "已有会话仍能改选工作区");
    const latest = await evaluate("JSON.parse(localStorage.getItem('bit-agent.task-history.v1'))[0]");
    const saved = await evaluate(`window.bitAgent.getSession(${JSON.stringify({gatewayUrl:latest.gatewayUrl,sessionId:latest.sessionId})})`);
    assert.equal(resolve(saved.session.workspace_root), resolve(selected), "后端会话没有绑定所选工作区");
    bindings.push({sessionId:latest.sessionId, workspaceRoot:latest.workspaceRoot});
  }
  assert.notEqual(bindings[0].sessionId,bindings[1].sessionId,"不同工作区复用了同一个会话");
  assert.deepEqual(bindings.map(item=>resolve(item.workspaceRoot)),[resolve(workspace),resolve(otherWorkspace)]);
  await evaluate("document.querySelector('.workspace-group[data-active=true] .workspace-group-action[data-action=new]').click()");
  assert.equal(await evaluate("document.querySelector('#workspace').value"),otherWorkspace,"工作区分组 + 没有预选目录");
  return bindings;
}

async function launch() {
  mainInspectorUrl = undefined;
  let launchOutput = "";
  const portServer = createSocketServer();
  await new Promise((done) => portServer.listen(0, "127.0.0.1", done));
  const port = portServer.address().port;
  await new Promise((done) => portServer.close(done));
  const env = { ...process.env, BIT_AGENT_DESKTOP_USER_DATA: join(directory, "profile"),
    BIT_AGENT_DATA_DIR: join(directory, "data"), BIT_AGENT_ACCEPTANCE_HIDDEN: "1",
    // 不让测试意外借用开发机上的 Python、Node、Git 或模型密钥。
    PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
  };
  for (const name of ["API_KEY", "BASE_URL", "MODEL_NAME", "BIT_AGENT_PROJECT_ROOT", "BIT_AGENT_PYTHON", "ELECTRON_RUN_AS_NODE", "PYTHONPATH"]) delete env[name];
  child = spawn(executable, [`--remote-debugging-port=${port}`, "--inspect=127.0.0.1:0", "--disable-gpu", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"], {
    cwd: directory, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (value) => {
    diagnostic += String(value);
    launchOutput += String(value);
    mainInspectorUrl = launchOutput.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1];
  });
  child.stdout.on("data", (value) => { diagnostic += String(value); });
  const page = await check(async () => {
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return tabs.find((tab) => tab.type === "page" && tab.url.includes("index.html"));
  }, "打包应用没有打开页面");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 0; const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const value = JSON.parse(data);
    if (value.method === "Page.javascriptDialogOpening") socket.send(JSON.stringify({ id: 800000, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
    const callback = pending.get(value.id);
    if (callback) { pending.delete(value.id); value.error ? callback.reject(new Error(JSON.stringify(value.error))) : callback.resolve(value.result); }
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`验收命令超时: ${method}`));
    }, 20_000);
    pending.set(id, {
      resolve(value) { clearTimeout(timer); resolve(value); },
      reject(error) { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await command("Page.enable");
  await command("Emulation.setFocusEmulationEnabled", { enabled: true });
  await check(() => evaluate("Boolean(window.bitAgent && document.querySelector('#model-settings'))"), "页面初始化失败");
  return { command, evaluate };
}
function inspectWindowsIcon() {
  const output = join(directory, "windows-executable-icon.png");
  const result = spawnSync(join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      join(root, "scripts", "desktop-package", "windows-shell-icon.ps1"), "-Executable", executable, "-Output", output],
    {encoding:"utf8",windowsHide:true});
  assert.equal(result.status, 0, `Windows Shell 图标读取失败: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function captureScreenshot() {
  await check(async () => mainInspectorUrl, "验收专用的主进程调试端口没有就绪");
  // Electron 自己的截图接口支持隐藏窗口，不依赖 Chromium 的窗口可见性判断。
  const connection = new WebSocket(mainInspectorUrl);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { connection.close(); reject(new Error("Electron 截图超时")); }, 20_000);
    const finish = (error, value) => {
      clearTimeout(timer);
      connection.close();
      if (error) reject(error); else resolve(value);
    };
    connection.addEventListener("error", () => finish(new Error("主进程截图连接失败")), { once:true });
    connection.addEventListener("open", () => connection.send(JSON.stringify({
      id:1, method:"Runtime.evaluate", params:{ awaitPromise:true, returnByValue:true, expression:`(async () => {
        const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app/package.json')('electron');
        const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('index.html'));
        window.webContents.setBackgroundThrottling(false);
        await window.webContents.capturePage(undefined, {stayHidden:true, stayAwake:true});
        await new Promise(done => setTimeout(done, 150));
        const sample = await window.webContents.executeJavaScript("(() => { const element = ['.zoom-controls:popover-open', '.product-dialog[open]', '.composer-card', '.editor-scroll', '.repository-view'].map((selector) => document.querySelector(selector)).find((item) => item && item.getBoundingClientRect().width > 0); const rect = element.getBoundingClientRect(); return { x:element.classList.contains('zoom-controls')?rect.left+10:rect.right-16, y:element.classList.contains('zoom-controls')?rect.top+rect.height/2:rect.top+16, width:innerWidth, height:innerHeight, color:getComputedStyle(element).backgroundColor.match(/\\\\d+/g).slice(0,3).map(Number) }; })()");
        const frame = await window.webContents.executeJavaScript("(() => { let marker=document.querySelector('#acceptance-frame'); if(!marker){marker=document.createElement('canvas');marker.id='acceptance-frame';marker.width=6;marker.height=6;document.body.append(marker);document.styleSheets[0].insertRule('#acceptance-frame{position:fixed;left:16px;top:16px;width:6px;height:6px;z-index:2147483647}',0)} (document.querySelector('.zoom-controls:popover-open')||document.querySelector('.product-dialog[open]')||document.body).append(marker);const pill=marker.parentElement?.matches('.zoom-controls:popover-open');marker.style.cssText='position:'+(pill?'absolute':'fixed')+';left:'+(pill?40:16)+'px;top:'+(pill?4:16)+'px;width:6px;height:6px;z-index:2147483647';const count=Number(window.acceptanceFrameCount||0)+1;window.acceptanceFrameCount=count;const color=[32+(count%6)*32,32+(Math.floor(count/6)%6)*32,32+(Math.floor(count/36)%6)*32];marker.getContext('2d').fillStyle='rgb('+color.join(',')+')';marker.getContext('2d').fillRect(0,0,6,6);const rect=marker.getBoundingClientRect();return {color,x:rect.left+3,y:rect.top+3}; })()");
        // 主题和唯一帧标记都匹配才接收截图，避免同一主题下仍取到旧菜单画面。
        let lastMismatch;
        for (let attempt = 0; attempt < 8; attempt++) {
          const image = await window.webContents.capturePage(undefined, {stayHidden:true, stayAwake:true});
          if (image.isEmpty()) throw new Error('截图为空');
          const size = image.getSize();
          const bitmap = image.toBitmap();
          const scale = Math.sqrt(bitmap.length / (4 * size.width * size.height));
          const width = Math.round(size.width * scale);
          const height = Math.round(size.height * scale);
          const x = Math.min(width - 1, Math.max(0, Math.floor(sample.x * width / sample.width)));
          const y = Math.min(height - 1, Math.max(0, Math.floor(sample.y * height / sample.height)));
          const offset = (y * width + x) * 4;
          const color = [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]];
          const markerX = Math.floor(frame.x * width / sample.width);
          const markerY = Math.floor(frame.y * height / sample.height);
          const markerOffset = (markerY * width + markerX) * 4;
          const frameColor = [bitmap[markerOffset + 2], bitmap[markerOffset + 1], bitmap[markerOffset]];
          lastMismatch = { color, expectedColor:sample.color, frameColor, expectedFrame:frame.color, sample, frame };
          if (color.every((value, index) => Math.abs(value - sample.color[index]) < 12)
            && frameColor.every((value, index) => Math.abs(value - frame.color[index]) <= 2)) {
            return { data:image.toPNG().toString('base64'), pixelThemeChecked:true };
          }
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        throw new Error('截图画面没有更新到当前主题：' + JSON.stringify(lastMismatch));
      })()` },
    })));
    connection.addEventListener("message", ({data}) => {
      const value = JSON.parse(data);
      if (value.id !== 1) return;
      const error = value.error ?? value.result?.exceptionDetails;
      finish(error ? new Error(JSON.stringify(error)) : null, value.result?.result?.value);
    });
  });
}
async function close() {
  if (!child || child.exitCode !== null) return;
  // 正常关闭窗口，实际触发应用的后台服务清理，而不是只杀一个外壳进程。
  const current = child;
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => { current.kill(); reject(new Error("应用未正常关闭")); }, 15_000);
    current.once("exit", () => { clearTimeout(timeout); done(); });
    socket?.send(JSON.stringify({ id: 900000, method: "Runtime.evaluate", params: { expression: "window.close()" } }));
  });
  socket?.close(); child = null;
}
async function captureLayouts(command, evaluate, stage) {
  if (process.env.BIT_AGENT_LAYOUT_STAGE && !process.env.BIT_AGENT_LAYOUT_STAGE.split(",").includes(stage)) return;
  for (const width of [1280, 920]) {
    const height = width === 920 ? 680 : 820;
    await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    for (const theme of ["light", "dark"]) {
      await evaluate(`(() => {
        if (document.documentElement.dataset.theme !== ${JSON.stringify(theme)}) document.querySelector('#theme-toggle').click();
        const panel = document.querySelector('.sidebar-right');
        const visible = getComputedStyle(panel).display !== 'none' && panel.getBoundingClientRect().width > 0;
        if (${width} <= 1050 && visible) document.querySelector('#inspector-close').click();
        if (${width} > 1050 && !visible) document.querySelector('#inspector-toggle').click();
      })()`);
      await check(() => evaluate(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`), "主题切换没有生效");
      const conversation = stage === "conversation"
        ? await verifyConversationLayout(evaluate, { history:true, supplement:true, longText:true }) : null;
      const markdown = stage === "markdown" ? await verifyMarkdown(evaluate, check) : null;
      if (markdown) await evaluate("document.querySelector('#current-turn .markdown-table').scrollIntoView({block:'start'})");
      // 隐藏窗口可能不再产生绘制帧；在测试进程稍等，再让截图命令直接请求画面。
      await new Promise(resolve => setTimeout(resolve, 150));
      const shot = await captureScreenshot();
      const filename = `${stage}-${theme}-${width}.png`;
      writeFileSync(join(directory, filename), Buffer.from(shot.data, "base64"));
      const geometry = await evaluate(`(() => {
        const rect = selector => {
          const element = document.querySelector(selector);
          if (!element || !element.getClientRects().length) return null;
          const r = element.getBoundingClientRect();
          return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width, height:r.height, overflow:element.scrollWidth-element.clientWidth };
        };
        const themeProbe = document.createElement('span');
        themeProbe.hidden = true; themeProbe.style.backgroundColor = 'var(--bg-main)'; document.body.append(themeProbe);
        const themeBackground = getComputedStyle(themeProbe).backgroundColor; themeProbe.remove();
        return { themeBackground, card:rect('.composer-card'), context:rect('.composer-context'), actions:rect('.composer-actions'),
          interaction:rect('#task-interaction'), dialog:rect('.product-dialog[open]'),
          dialogBackground:document.querySelector('.product-dialog[open]') ? getComputedStyle(document.querySelector('.product-dialog[open]')).backgroundColor : null,
          settingsInSidebar:Boolean(document.querySelector('#model-settings').closest('.sidebar-bottom')),
          permissionInToolbar:Boolean(document.querySelector('#permission-mode').closest('.composer-toolbar')),
          reviewInInspector:Boolean(document.querySelector('#review-changes').closest('.inspector-heading')),
          extraComposerRow:Boolean(document.querySelector('.composer-card .product-controls')),
          menu:rect('.choice-popover:not([hidden])') ?? rect('#profile-menu:not([hidden])') };
      })()`);
      assert(geometry.settingsInSidebar && geometry.permissionInToolbar && geometry.reviewInInspector && !geometry.extraComposerRow, "新入口不在约定的位置");
      const inside = r => r && r.x >= -1 && r.y >= -1 && r.right <= width + 1 && r.bottom <= height + 1;
      // 仓库页没有输入框，只检查对话页的输入框布局。
      if (geometry.card) {
        assert(inside(geometry.card), `${filename}: 输入框超出窗口`);
        assert(geometry.card.overflow <= 1, `${filename}: 输入框出现横向溢出`);
        const { context, actions } = geometry;
        assert(context.right <= actions.x + 1 || context.bottom <= actions.y + 1 || actions.bottom <= context.y + 1, `${filename}: 底栏控件相互遮挡`);
      }
      if (geometry.interaction) {
        assert(inside(geometry.interaction), `${filename}: 问答卡片超出窗口`);
        assert(geometry.interaction.bottom <= geometry.card.y + 1, `${filename}: 问答卡片侵入输入框`);
      }
      if (geometry.menu) assert(inside(geometry.menu), `${filename}: 选择菜单超出窗口`);
      if (geometry.dialog) {
        assert(inside(geometry.dialog), `${filename}: 弹窗超出窗口`);
        assert(Math.abs(geometry.dialog.x + geometry.dialog.width / 2 - width / 2) <= 2, `${filename}: 弹窗没有居中`);
        assert.equal(geometry.dialogBackground, geometry.themeBackground, `${filename}: 弹窗没有使用当前主题`);
      }
      layoutResults.push({ stage, theme, width, height, screenshot:filename, pixelThemeChecked:shot.pixelThemeChecked, geometry,
        ...(conversation ? { conversation } : {}), ...(markdown ? { markdown } : {}) });
      console.log("LAYOUT_PASSED", filename);
    }
  }
  await command("Emulation.setDeviceMetricsOverride", { width:1280, height:820, deviceScaleFactor:1, mobile:false });
  await evaluate("if(document.documentElement.dataset.theme!=='light')document.querySelector('#theme-toggle').click();if(getComputedStyle(document.querySelector('.sidebar-right')).display==='none')document.querySelector('#inspector-toggle').click()");
}
// 用安装包自带的 Python 和代码预先写入两条长期记忆：一条属于验收工作区，一条属于别的项目。
function seedMemories() {
  const python = join(executable, "..", "resources", "python", "python.exe");
  const code = `
import asyncio, sys
from pathlib import Path
from bit_agent.memory import MemoryCandidate, MemoryKind, MemoryRecord, SQLiteLongTermMemoryStore
from bit_agent.runtime.application.long_term_memory import project_id_for
data, workspace = sys.argv[1], sys.argv[2]
def record(title, project):
    item = MemoryCandidate(kind=MemoryKind.PROCEDURE, memory_key="project.package." + title.lower().replace("-", "_"),
        title=title, content=title + "：打包验收写入的长期记忆内容，用于检查面板显示。", applicability="打包验收",
        evidence_summary="打包验收", importance=0.8, confidence=0.9)
    return MemoryRecord.from_candidate(item, source_run_id="package-run", project_id=project, user_id=None)
async def main():
    store = SQLiteLongTermMemoryStore(Path(data) / "long_term_memory.sqlite3")
    await store.save_many([record("PACKAGE-MEMORY-CANARY", project_id_for(Path(workspace))),
                           record("OTHER-PROJECT-MEMORY", "d:/elsewhere/other-project")])
    store.close()
asyncio.run(main())
`;
  mkdirSync(join(directory, "data"), { recursive: true });
  const result = spawnSync(python, ["-c", code, join(directory, "data"), workspace], { encoding: "utf8" });
  assert.equal(result.status, 0, `写入验收记忆失败：${result.stderr}`);
}
try {
  seedMemories();
  let { command, evaluate } = await launch();
  await check(() => evaluate("document.querySelector('#status').dataset.status==='IDLE' && document.querySelector('#run').dataset.state==='send' && Boolean(document.querySelector('#run svg path')) && document.querySelector('#run').disabled && document.querySelector('#run').dataset.empty==='true'"), "首次进入未显示灰色发送图标");
  assert(await evaluate("document.querySelector('#profile-theme')===null"), "个人中心还保留重复主题入口");
  assert(await evaluate("Boolean(document.querySelector('#theme-toggle'))"), "侧栏主题按钮丢失");
  await evaluate("document.querySelector('#objective').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  assert(await evaluate("document.querySelector('#status').dataset.status==='IDLE' && document.querySelector('.error-actions').hidden"), "空 Enter 不应触发任务或错误");
  await captureLayouts(command, evaluate, "startup");
  const windowsIcon = inspectWindowsIcon();
  assert(windowsIcon.orange > 25 && windowsIcon.white > 3, `Windows 读取到的 EXE 图标不是橙色 B 标识: ${JSON.stringify({size:windowsIcon.size,orange:windowsIcon.orange,white:windowsIcon.white})}`);
  const configuration = await evaluate("window.bitAgent.runtimeConfig");
  await check(() => evaluate("document.querySelector('#connection-dot').dataset.connected==='true' && document.querySelector('#connection-dot').title==='本地服务已就绪'"), "本地服务没有自动连接");
  assert.equal(configuration.managed, true);
  assert.equal((await fetch(configuration.gatewayUrl + "/health")).status, 401);
  await evaluate(`window.bitAgent.saveModelSettings(${JSON.stringify({ baseUrl: modelUrl, model: "local-fixture", apiKey: "LOCAL-PACKAGE-SECRET-ONLY" })})`);
  const publicSettings = await evaluate("window.bitAgent.getModelSettings()");
  assert.equal(publicSettings.configured, true);
  assert.equal(publicSettings.apiKey, undefined);
  const diskSettings = readFileSync(join(directory, "profile", "model-settings.json"), "utf8");
  assert(!diskSettings.includes("LOCAL-PACKAGE-SECRET-ONLY"));
  // 密钥留空时用已保存的密钥；自动检测选中第一种可用的接口。
  const probe = await evaluate(`window.bitAgent.testModelSettings(${JSON.stringify({ baseUrl: modelUrl, model: "local-fixture", apiKey: "", api: "auto" })})`);
  assert.equal(probe.ok, true, JSON.stringify(probe));
  assert.equal(probe.api, "responses");
  assert.deepEqual(probes, [{ path: "/v1/responses", tools: ["noop"] }]);
  assert(await evaluate("document.querySelector('#connection')===null && document.querySelector('#workspace').value==='' && document.querySelector('#workspace-chooser .choice-value').textContent==='选择工作区'"), "启动新聊天没有显示空工作区选择");
  await evaluate(`localStorage.setItem('bit-agent.workspaces.v1',${JSON.stringify(JSON.stringify([workspace,otherWorkspace]))});document.querySelector('#new-task').click()`);
  await chooseWorkspace(evaluate, workspace);
  await evaluate("document.querySelector('#objective').value='PACKAGE-CANARY-73'; document.querySelector('#objective').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#run').click();");
  await check(() => evaluate("document.body.dataset.busy==='true' && document.querySelector('#current-turn').textContent.includes('PACKAGED_STREAM_START')"), "最终完成之前没有收到流式文字");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='COMPLETED' && document.body.dataset.busy==='false' && document.querySelector('#run').dataset.state==='send'"), "独立包未完成第一轮");
  const state = await evaluate("({ status:document.querySelector('#status').dataset.status, answer:document.querySelector('#current-turn').textContent, gateway:window.bitAgent.runtimeConfig.gatewayUrl })");
  assert(state.answer.includes("PACKAGE-CANARY-73"));
  const screenshot = await captureScreenshot();
  writeFileSync(join(directory, "packaged-desktop.png"), Buffer.from(screenshot.data, "base64"));
  await verifyConversationLayout(evaluate);
  // 侧边栏按工作区分组；左下角个人中心显示版本 1.0，页面上不再有 Local harness。
  assert(await evaluate("document.querySelector('.workspace-group[data-active=true] .workspace-group-name')?.textContent==='workspace' && document.querySelectorAll('.workspace-group[data-active=true] .history-item').length===1"), "对话没有归到所在工作区下");
  await evaluate("document.querySelector('.workspace-group[data-active=true] .workspace-group-toggle').click()");
  assert(await evaluate("document.querySelector('.workspace-group[data-active=true] .workspace-group-items').hidden"), "工作区分组不能折叠");
  await evaluate("document.querySelector('.workspace-group[data-active=true] .workspace-group-toggle').click()");
  assert(await evaluate("!document.body.innerText.includes('Local harness') && document.querySelector('#profile-button').textContent.includes('Bit Agent 1.0')"), "个人中心没有显示版本号 1.0");
  await evaluate("document.querySelector('#profile-button').click()");
  await check(() => evaluate("!document.querySelector('#profile-menu').hidden && ['#model-settings','#execution-settings','#mcp-settings','#memory-settings','#diagnostics-settings','#terminal-settings'].every(s=>document.querySelector('#profile-menu').contains(document.querySelector(s)))"), "个人中心菜单没有包含全部设置");
  assert(await evaluate("document.querySelector('#gateway')===null && document.querySelector('#health')===null && !document.querySelector('#profile-menu').textContent.includes('连接设置')"), "个人中心仍显示 Gateway 连接设置");
  assert(await evaluate("[...document.querySelectorAll('.profile-menu-items button')].length===6"), "个人中心设置项数量不正确");
  await captureLayouts(command, evaluate, "profile-menu");
  await evaluate("document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
  await check(() => evaluate("document.querySelector('#profile-menu').hidden"), "点击别处没有收起个人中心菜单");
  // Codex 风格的权限菜单：三项、当前项打勾，选中后值随之改变。
  await evaluate("document.querySelector('#permission-mode .choice-trigger').click()");
  await check(() => evaluate("document.querySelectorAll('#permission-mode .choice-popover:not([hidden]) .choice-item').length===3 && document.querySelector('#permission-mode .choice-item[aria-checked=true]').dataset.value==='confirm'"), "权限菜单没有打开");
  await captureLayouts(command, evaluate, "permission-menu");
  await evaluate("document.querySelector('#permission-mode .choice-item[data-value=edit]').click()");
  assert.equal(await evaluate("document.querySelector('#permission-mode').value"), "edit");
  assert(await evaluate("document.querySelector('#permission-mode .choice-popover').hidden"), "选中后菜单没有收起");
  await evaluate("document.querySelector('#permission-mode .choice-trigger').click();document.querySelector('#permission-mode .choice-item[data-value=confirm]').click()");
  assert.equal(await evaluate("document.querySelector('#permission-mode').value"), "confirm");
  await evaluate("document.querySelector('#model-settings').click()");
  await check(() => evaluate("Boolean(document.querySelector('.model-settings-form'))"), "模型设置表单没有打开");
  await captureLayouts(command, evaluate, "model-settings");
  // 从服务获取模型列表（过滤掉向量模型），勾选一个加进“可切换的模型”。
  await evaluate("document.querySelector('[data-fetch-models]').click()");
  await check(() => evaluate("document.querySelectorAll('.model-fetch-result input').length===2"), "从服务获取模型列表失败");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.model-fetch-result input')].map(i=>i.value)"), ["local-fixture", "local-fixture-mini"]);
  await evaluate("[...document.querySelectorAll('.model-fetch-result input')].find(i=>i.value==='local-fixture-mini').click()");
  assert(await evaluate("document.querySelector('#model-list').value.includes('local-fixture-mini')"), "勾选的模型没有加进列表");
  await evaluate("document.querySelector('.model-settings-form').requestSubmit()");
  await check(() => evaluate("Boolean(document.querySelector('.product-feedback[data-kind=success]'))"), "设置表单无法保存");
  await evaluate("document.querySelector('.product-dialog-header button').click()");
  // 输入框右下角的模型菜单：换成 local-fixture-mini、思考程度“高”，下一轮请求要带上它们。
  await check(() => evaluate("document.querySelector('#model-menu .choice-value')?.textContent==='local-fixture'"), "模型菜单没有显示主模型");
  await evaluate("document.querySelector('#model-menu .choice-trigger').click()");
  await check(() => evaluate("[...document.querySelectorAll('#model-menu .choice-item strong')].some(e=>e.textContent==='local-fixture-mini')"), "模型菜单没有列出可切换的模型");
  await captureLayouts(command, evaluate, "model-menu");
  await evaluate("[...document.querySelectorAll('#model-menu .choice-item')].find(e=>e.querySelector('strong')?.textContent==='local-fixture-mini').click()");
  await evaluate("document.querySelector('#model-menu .choice-trigger').click()");
  await check(() => evaluate("!document.querySelector('#model-menu .choice-popover').hidden"), "模型菜单没有再次打开");
  await evaluate("[...document.querySelectorAll('#model-menu .choice-item')].find(e=>e.querySelector('strong')?.textContent==='高').click()");
  await check(() => evaluate("document.querySelector('#model-menu .choice-value').textContent==='local-fixture-mini' && document.querySelector('#model-menu .model-effort')?.textContent==='高'"), "模型菜单的选择没有生效");
  // 旧版地址配置和历史地址不能把当前本地服务改为过期端口。
  await evaluate("localStorage.setItem('bit-agent.gateway-url.v1','http://127.0.0.1:1');const h=JSON.parse(localStorage.getItem('bit-agent.task-history.v1')||'[]');localStorage.setItem('bit-agent.task-history.v1',JSON.stringify(h.map(e=>({...e,gatewayUrl:'http://127.0.0.1:1'}))))");
  await close();
  ({ command, evaluate } = await launch());
  await check(() => evaluate("document.querySelector('#connection-dot').dataset.connected==='true' && window.bitAgent.runtimeConfig.gatewayUrl!=='http://127.0.0.1:1'"), "重启被旧 Gateway 配置覆盖");
  await check(() => evaluate("Array.from(document.querySelectorAll('.history-item')).some(button=>button.title==='PACKAGE-CANARY-73')"), "重启后没有恢复已存会话");
  await evaluate("Array.from(document.querySelectorAll('.history-item')).find(button=>button.title==='PACKAGE-CANARY-73').click()");
  await check(() => evaluate("document.body.dataset.busy === 'false' && document.querySelector('#run').dataset.state==='send' && document.querySelector('#current-turn').textContent.includes('PACKAGE-CANARY-73')"), "历史回答没有恢复");
  await evaluate("document.querySelector('#objective').value='PACKAGE-FOLLOWUP';document.querySelector('#objective').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#run').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='COMPLETED' && document.body.dataset.busy==='false' && document.querySelector('#run').dataset.state==='send' && document.querySelector('#current-turn').textContent.includes('PACKAGE-FOLLOWUP')"), "重启后不能继续对话");
  const followup = await evaluate("document.querySelector('#current-turn').textContent");
  assert(followup.includes("PACKAGE-CANARY-73"), `继续对话的回答没有带上前一轮：${followup}`);
  // 重启后仍记得模型菜单的选择，请求里带着所选模型和思考程度。
  const chosen = requests.filter((body) => body.tools?.length && JSON.stringify(body.input).includes("PACKAGE-FOLLOWUP")).at(-1);
  assert(chosen, "没有找到这一轮主 Agent 的模型请求");
  assert.equal(chosen.model, "local-fixture-mini", `请求没有使用所选模型：${chosen.model}`);
  assert.equal(chosen.reasoning?.effort, "high", `请求没有带上思考程度：${JSON.stringify(chosen.reasoning)}`);
  // 点击一次即显示已停止；后台取消不能让界面回退为等待/暂停。
  await evaluate("document.querySelector('#objective').value='STOP-NOW';document.querySelector('#objective').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#run').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='RUNNING' && document.querySelector('#run').dataset.state==='running'"), "停止测试没有开始运行");
  assert(await evaluate("document.querySelector('#cancel').hidden"), "仍然单独显示停止按钮");
  const stopped = await evaluate("document.querySelector('#run').click();({status:document.querySelector('#status').textContent,line:document.querySelector('#status-line').textContent,interaction:document.querySelector('#task-interaction').hidden,spinner:document.querySelector('#run .run-spinner')!==null})");
  assert.equal(stopped.status, "已停止"); assert(stopped.line.includes("已停止")); assert(stopped.interaction); assert.equal(stopped.spinner,false);
  await captureLayouts(command, evaluate, "stopped");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='CANCELLED' && document.body.dataset.busy==='false'"), "停止后的后台取消未完成");
  assert(await evaluate("![...document.querySelectorAll('#stream .stream-note')].some(e=>/正在暂停|等待当前|任务已暂停/.test(e.textContent)) && !document.querySelector('#status-line').textContent.includes('正在')"), "停止后还有内部过程提示");
  const border = await evaluate("({top:document.querySelector('.shell').getBoundingClientRect().top,bottom:document.querySelector('.window-titlebar').getBoundingClientRect().bottom,width:document.querySelector('.shell').getBoundingClientRect().width,border:getComputedStyle(document.querySelector('.shell')).borderTopWidth,viewport:innerWidth})");
  assert.equal(border.top,border.bottom); assert(Math.abs(border.width-border.viewport)<1,"分隔线没有覆盖整个窗口宽度"); assert(Number.parseFloat(border.border)>0 && Number.parseFloat(border.border)<=1,"分隔线没有实际渲染");
  // 运行中直接在输入框补充要求：先排队，Agent 下一步读取，最终回答里能看到。
  await evaluate("document.querySelector('#objective').value='RUN-NOTE-TEST';document.querySelector('#objective').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#run').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='RUNNING' && !document.querySelector('#objective').disabled"), "运行中输入框不能补充要求");
  const runningNote = "RUNNING-NOTE\n" + "这条补充要求用于检查用户长句气泡在对话区内正确换行。".repeat(16)
    + "\n" + "abcdefghijklmnopqrstuvwxyz".repeat(20);
  await evaluate(`const r=document.querySelector('#objective');r.value=${JSON.stringify(runningNote)};r.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await check(() => evaluate("document.querySelector('#status').dataset.status==='COMPLETED' && document.body.dataset.busy==='false' && document.querySelector('#stream .stream-user')?.textContent.includes('RUNNING-NOTE') && [...document.querySelectorAll('#stream .stream-text')].some(e=>e.textContent.includes('RUNNING-NOTE'))"), "运行中补充的要求没有被 Agent 读到");
  assert(await evaluate("[...document.querySelectorAll('.saved-turn .stream-note')].some(e=>e.textContent.includes('已停止'))"), "继续对话后上一轮的执行过程不见了");
  await verifyConversationLayout(evaluate, { history:true, supplement:true, longText:true });
  await captureLayouts(command, evaluate, "conversation");
  // 运行中写字：工具栏出现“引导 / 排队”；按 Tab 排队，这一轮结束后自动作为下一条消息发送。
  await evaluate("document.querySelector('#objective').value='QUEUE-TEST';document.querySelector('#objective').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#run').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='RUNNING' && document.querySelector('#run').dataset.state==='running'"), "QUEUE-TEST 没有开始运行");
  const queueSnapshot = await evaluate("const q=document.querySelector('#objective');q.value='QUEUED-NOTE';q.dispatchEvent(new Event('input'));({status:document.querySelector('#status').dataset.status,busy:document.body.dataset.busy,mode:document.body.dataset.steering,choiceHidden:document.querySelector('#steer-choice').hidden,state:document.querySelector('#run').dataset.state,value:q.value,stream:document.querySelector('#stream').textContent.slice(-300)})");
  assert.equal(queueSnapshot.state,"send"); assert.equal(queueSnapshot.choiceHidden,false);
  await check(() => evaluate("!document.querySelector('#steer-choice').hidden && document.querySelector('#run').dataset.state==='send'"), "运行中写字后没有出现“引导 / 排队”");
  writeFileSync(join(directory, "running-steer.png"), Buffer.from((await captureScreenshot()).data, "base64"));
  await evaluate("document.querySelector('#objective').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}))");
  assert(await evaluate("document.querySelector('#objective').value==='' && document.querySelector('#queued-messages .queued-text')?.textContent==='QUEUED-NOTE'"), "按 Tab 没有把消息排进队列");
  await check(async () => responseGates.has("QUEUE-TEST"), "本地模型未进入排队测试");
  releaseResponse("QUEUE-TEST");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='COMPLETED' && document.body.dataset.busy==='false' && document.querySelector('#run').dataset.state==='send' && document.querySelector('#objective-display').textContent==='QUEUED-NOTE' && document.querySelector('#queued-messages').hidden"), "这一轮结束后排队的消息没有自动发送");
  // 主动停止后，已有排队消息不会自动发送。
  await evaluate("document.querySelector('#objective').value='STOP-QUEUE';document.querySelector('#objective').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#run').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='RUNNING'"), "排队停止测试没有开始");
  await evaluate("const o=document.querySelector('#objective');o.value='DO-NOT-AUTO-SEND';o.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));document.querySelector('#run').click()");
  releaseResponse("STOP-QUEUE");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='CANCELLED' && document.body.dataset.busy==='false'"), "排队停止没有完成");
  assert.equal(await evaluate("document.querySelector('#objective-display').textContent"),"STOP-QUEUE");
  assert(await evaluate("document.querySelector('#queued-messages .queued-text')?.textContent==='DO-NOT-AUTO-SEND'"),"主动停止后排队消息意外发出");
  await evaluate("document.querySelector('#queued-messages .queued-remove').click()");
  await evaluate("document.querySelector('#objective').value='PACKAGE-EDIT';document.querySelector('#objective').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#run').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='WAITING_FOR_INPUT' && !document.querySelector('.operation-details').hidden"), "文件修改没有要求用户授权");
  const { existsSync } = await import("node:fs");
  assert(!existsSync(join(workspace, "package-demo.py")));
  await captureLayouts(command, evaluate, "approval");
  await evaluate("document.querySelector('input[name=agent-question-option][value=approve]').click();document.querySelector('#submit-question-answer').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='WAITING_FOR_INPUT' && document.querySelector('.question-title').textContent.includes('等待审阅')"), "批准后工具未执行或问题卡片未更新");
  // 修改文件那一行写增删行数（像 Claude Code 一样），批准后不再单独一行“已收到你的回答”。
  await check(() => evaluate("[...document.querySelectorAll('#current-turn .stream-tool[data-tool=apply_patch] .tool-summary')].some(s=>s.textContent==='+1 −0')"), "修改文件没有显示增删行数");
  await verifyFoldedPatch(evaluate, check);
  await verifyNoEmptyText(evaluate);
  assert(!(await evaluate("document.querySelector('#current-turn').textContent.includes('已收到你的回答')")), "批准后仍单独显示“已收到你的回答”");
  assert(existsSync(join(workspace, "package-demo.py")));
  assert(await evaluate("!document.querySelector('#end-task').hidden && document.querySelector('#run').dataset.state==='waiting'"), "等待回答时卡片上没有“结束这一轮”");
  await evaluate("document.querySelector('#end-task').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='CANCELLED' && document.body.dataset.busy==='false'"), "等待回答时不能取消");
  await evaluate("document.querySelector('#review-changes').click()");
  await check(() => evaluate("Boolean(document.querySelector('.change-entry .diff-view')?.textContent.includes('package fixture'))"), "审阅界面没有显示真实差异");
  const reviewDiff = await evaluate(`(() => { const view=document.querySelector('.change-entry .diff-view'), row=view.querySelector('tr[data-kind=add]');
    return { mode:view.dataset.mode, numbers:[...row.querySelectorAll('.diff-num')].map(cell=>cell.textContent),
      highlighted:Boolean(row.querySelector('.diff-code .tok-string')), header:Boolean(view.querySelector('tr[data-kind]')?.textContent.includes('+++')),
      stats:document.querySelector('.change-file .diff-stats').textContent }; })()`);
  assert.deepEqual(reviewDiff, { mode:"unified", numbers:["", "1"], highlighted:true, header:false, stats:"+1−0" }, "审阅差异没有行号、高亮或增删统计");
  await check(() => evaluate("Boolean(document.querySelector('.git-commit .git-files')?.textContent.includes('package-demo.py'))"), "提交面板没有列出任务改过的文件")
    .catch(async (error) => { throw new Error(`${await evaluate("document.querySelector('.product-dialog')?.innerText ?? ''")}\n${error.message}`); });
  await captureLayouts(command, evaluate, "review");
  await evaluate("document.querySelector('.diff-mode button[data-mode=split]').click()");
  const splitDiff = await evaluate(`(() => { const view=document.querySelector('.change-entry .diff-view[data-mode=split]'), row=view?.querySelector('tr:not(.diff-banner)');
    return row ? { left:row.cells[1].dataset.empty, right:row.cells[3].textContent, number:row.cells[2].textContent } : null; })()`);
  assert.deepEqual(splitDiff, { left:"true", right:"print('package fixture')", number:"1" }, "并排差异没有把新增放在右侧");
  await captureLayouts(command, evaluate, "review-split");
  await evaluate("document.querySelector('.diff-mode button[data-mode=unified]').click()");
  // 用随包附带的 Git 提交：验收进程的 PATH 里没有系统 Git。
  await evaluate("const t=document.querySelector('.git-message textarea');t.value='PACKAGE-COMMIT';t.dispatchEvent(new Event('input'));document.querySelector('.git-actions .button-primary').click()");
  await check(() => evaluate("Boolean(document.querySelector('.product-feedback[data-kind=success]')?.textContent.includes('已提交'))"), "界面提交到 Git 没有成功");
  assert.deepEqual(gitSetup("log", "-1", "--name-only", "--format=%s").split(/\r?\n/u).filter(Boolean), ["PACKAGE-COMMIT", "package-demo.py"]);
  await evaluate("Array.from(document.querySelectorAll('.change-entry button')).find(button=>button.textContent==='撤销这次改动').click()");
  await check(async () => !existsSync(join(workspace, "package-demo.py")), "界面撤销没有恢复原文件状态");
  await evaluate("document.querySelector('.product-dialog-header button').click()");
  // 外部工具：用便携包自带的 Python 启动本项目的 MCP Server（stdio）。环境变量值加密保存、不回到页面。
  const bundledPython = join(executable, "..", "resources", "python", "python.exe");
  const mcpServer = { name: "self", type: "stdio", command: bundledPython,
    args: ["-m", "bit_agent.mcp_server", "--workspace", workspace], enabled: true, auto_approve: false,
    env: { PROBE_TOKEN: "MCP-SECRET-CANARY" } };
  const savedTools = await evaluate(`window.bitAgent.saveMcpServers(${JSON.stringify([mcpServer])})`);
  assert.deepEqual(savedTools.map((item) => [item.name, item.envKeys, item.env]), [["self", ["PROBE_TOKEN"], undefined]]);
  assert(!readFileSync(join(directory, "profile", "mcp-servers.json"), "utf8").includes("MCP-SECRET-CANARY"), "外部工具密钥被明文保存");
  const probeTools = await evaluate(`window.bitAgent.testMcpServer(${JSON.stringify({ ...mcpServer, env: undefined })})`);
  assert(probeTools.ok && probeTools.tools.includes("list_files"), JSON.stringify(probeTools));
  await evaluate("document.querySelector('#mcp-settings').click()");
  await check(() => evaluate("document.querySelectorAll('.mcp-entry').length===1 && document.querySelector('.mcp-env')?.textContent.includes('PROBE_TOKEN')"), "外部工具面板没有列出服务");
  await captureLayouts(command, evaluate, "mcp");
  await evaluate("document.querySelector('.product-dialog-header button').click()");
  // 新开一段对话：上一段对话撤销过改动，下一轮会被要求重新验证，与外部工具无关。
  // 用工作区标题右侧的 + 在同一工作区新开对话。
  await evaluate("document.querySelector('.workspace-group[data-active=true] .workspace-group-action[data-action=new]').click()");
  await check(() => evaluate("document.querySelector('#task-id').textContent==='新任务' && !document.querySelector('#empty-state').hidden"), "工作区的 + 没有新开对话");
  await evaluate("document.querySelector('#objective').value='PACKAGE-MCP';document.querySelector('#objective').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#run').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='WAITING_FOR_INPUT' && document.querySelector('.question-title').textContent.includes('调用外部工具 self · list_files')"), "调用外部工具前没有要求确认");
  await evaluate("document.querySelector('input[name=agent-question-option][value=approve]').click();document.querySelector('#submit-question-answer').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='COMPLETED' && document.body.dataset.busy==='false'"), "批准后外部工具任务没有完成");
  const mcpTask = await evaluate("(async()=>{const h=JSON.parse(localStorage.getItem('bit-agent.task-history.v1'));const t=h[0];return window.bitAgent.getResult({gatewayUrl:t.gatewayUrl,taskId:t.taskId});})()");
  assert.equal(mcpTask.result.final_answer, "PACKAGE-MCP-DONE", JSON.stringify(mcpTask.result.final_answer));
  assert.equal(mcpTask.result.tool_calls[0].tool_name, "mcp__self__list_files");
  assert(JSON.stringify(mcpTask.result.tool_calls[0].output).includes("README.md"), "外部工具没有返回工作区文件列表");
  // 同一对话继续：连续的查看/读取合成一行分组，默认收起，展开后逐条列出，点开一条显示可读信息。
  await evaluate("document.querySelector('#objective').value='PACKAGE-GROUP';document.querySelector('#objective').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#run').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='COMPLETED' && document.body.dataset.busy==='false'"), "读取文件的任务没有完成");
  // 外部工具连接成功只在对话第一轮提示；这是同一对话的第二轮。
  assert(!(await evaluate("document.querySelector('#current-turn').textContent.includes('已连接外部工具')")), "后续轮次仍重复提示外部工具已连接");
  const group = "[...document.querySelectorAll('#current-turn .stream-group')].at(-1)";
  assert.equal(await evaluate(`${group}?.querySelector('.group-summary')?.textContent`), "查看了 1 个目录，读取了 2 个文件");
  assert(await evaluate(`${group}.querySelector('.group-list').hidden && ${group}.querySelector('.group-head').getAttribute('aria-expanded')==='false'`), "工具分组默认应收起");
  assert(await evaluate(`${group}.querySelector('.group-summary').getBoundingClientRect().width>150`), "分组摘要被挤窄，文字看不见");
  writeFileSync(join(directory, "tool-group-collapsed.png"), Buffer.from((await captureScreenshot()).data, "base64"));
  await evaluate(`${group}.querySelector('.group-head').click()`);
  assert(await evaluate(`!${group}.querySelector('.group-list').hidden && ${group}.querySelectorAll('.group-list > .stream-tool').length===3`), "展开后没有逐条列出 3 次调用");
  await evaluate(`${group}.querySelector('.group-list > .stream-tool .tool-head').click()`);
  assert(await evaluate(`(() => { const d=${group}.querySelector('.group-list > .stream-tool .tool-detail'); return !d.hidden && d.textContent.includes('状态') && !d.querySelector('.tool-raw,.event-payload') && ![...d.querySelectorAll('dt')].some(term=>term.textContent==='工具'); })()`), "工具详情缺少可读信息或仍显示内部调试数据");
  writeFileSync(join(directory, "tool-group.png"), Buffer.from((await captureScreenshot()).data, "base64"));
  const browserAgent = await verifyBrowserAgent({ evaluate, check, main:expression=>evaluateMain(mainInspectorUrl,expression) });
  console.log("BROWSER_AGENT_PASSED", JSON.stringify(browserAgent));
  await evaluate("document.querySelector('#memory-settings').click()");
  const memoryTitles = "Array.from(document.querySelectorAll('.memory-entry strong')).map(item=>item.textContent)";
  await check(async () => JSON.stringify(await evaluate(memoryTitles)) === JSON.stringify(["PACKAGE-MEMORY-CANARY"]), "记忆面板没有只显示本项目的记忆");
  await evaluate("document.querySelector('#memory-show-all').click()");
  await check(async () => (await evaluate(memoryTitles)).length === 2, "勾选“显示所有项目”后没有列出全部记忆");
  await captureLayouts(command, evaluate, "memory");
  await evaluate("Array.from(document.querySelectorAll('.memory-entry')).find(item=>item.textContent.includes('OTHER-PROJECT-MEMORY')).querySelector('.memory-delete').click()");
  await check(async () => JSON.stringify(await evaluate(memoryTitles)) === JSON.stringify(["PACKAGE-MEMORY-CANARY"]), "界面删除记忆没有生效");
  // 重启后 Gateway 端口会变，用当前这次启动的地址。
  const remaining = await evaluate("window.bitAgent.listMemories({ gatewayUrl: window.bitAgent.runtimeConfig.gatewayUrl })");
  assert.deepEqual(remaining.memories.map((item) => item.title), ["PACKAGE-MEMORY-CANARY"]);
  await evaluate("document.querySelector('.product-dialog-header button').click()");
  // 对话搜索（后续轮次修改后的要求也能搜到）、重命名和删除。
  const search = (text) => evaluate(`{const s=document.querySelector('#session-search');s.value=${JSON.stringify(text)};s.dispatchEvent(new Event('input'))}`);
  await search("PACKAGE-FOLLOWUP");
  await check(() => evaluate("document.querySelectorAll('.history-item').length===1 && document.querySelector('.history-item').title==='PACKAGE-CANARY-73'"), "按后续轮次的要求搜索不到对话");
  await search("NO-SUCH-CONVERSATION");
  await check(() => evaluate("document.querySelectorAll('.history-item').length===0 && !document.querySelector('#history-empty').hidden"), "搜索不到时没有显示空结果");
  await search("");
  // 两段对话：最新的是外部工具那一段。
  await check(() => evaluate("document.querySelectorAll('.history-item').length===2"), "清空搜索后没有恢复列表");
  await evaluate("document.querySelector('.history-actions [data-action=rename]').click()");
  await evaluate("{const i=document.querySelector('.history-rename');i.value='PACKAGE-RENAMED';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))}");
  await check(() => evaluate("document.querySelector('.history-item')?.title==='PACKAGE-RENAMED'"), "界面重命名没有生效");
  const listSessions = "window.bitAgent.listSessions(window.bitAgent.runtimeConfig.gatewayUrl, 0)";
  assert((await evaluate(listSessions)).sessions.some((session) => session.title === "PACKAGE-RENAMED"));
  await evaluate("document.querySelector('.history-actions [data-action=delete]').click()");
  await check(() => evaluate("document.querySelectorAll('.history-item').length===1 && document.querySelector('.history-item').title==='PACKAGE-CANARY-73'"), "界面删除对话没有生效");
  assert.deepEqual((await evaluate(listSessions)).sessions.map((session) => session.title), ["PACKAGE-CANARY-73"]);
  // 重新打开多轮对话：更早的轮次不用点开，自动回放出执行过程。
  await evaluate("document.querySelector('.history-item').click()");
  await check(() => evaluate("(()=>{const t=document.querySelector('.saved-turn');return document.body.dataset.busy==='false' && Boolean(t) && !document.querySelector('.turn-expand') && Boolean(t.querySelector('.stream-text')?.textContent.includes('PACKAGED_STREAM_START'));})()"), "旧轮次没有自动回放执行过程");
  await verifyConversationLayout(evaluate, { history:true, update:true, longText:true });
  await evaluate("document.querySelector('#objective').value='PACKAGE-MARKDOWN';document.querySelector('#objective').dispatchEvent(new Event('input'));document.querySelector('#run').click()");
  await check(() => evaluate("document.body.dataset.busy==='false' && document.querySelector('#current-turn').textContent.includes('PACKAGED_STREAM_END')"), "Markdown 验收回复没有完成");
  const markdownRendering = await verifyMarkdown(evaluate, check);
  markdownRendering.copy = await verifyCopy({ command, evaluate, check,
    main:expression=>evaluateMain(mainInspectorUrl,expression) });
  await captureLayouts(command, evaluate, "markdown");
  await evaluate("document.querySelector('.history-item[data-active=true]').click()");
  await check(() => evaluate("document.body.dataset.busy==='false'"), "Markdown 历史回放没有完成");
  markdownRendering.historyReplay = await verifyMarkdown(evaluate, check);
  // VS Code 式仓库页：标签页、行号、语法高亮、状态栏。
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "app.py"), "# 示例\ndef greet(name: str) -> str:\n    return f\"hi {name}\"  # 问候\n\nprint(greet('bit'), 42)\n");
  await evaluate("document.querySelector('#nav-repository').click()");
  await check(() => evaluate("Boolean(document.querySelector('.repository-entry[data-path=\"src\"]'))"), "仓库页没有列出目录");
  await evaluate("document.querySelector('.repository-entry[data-path=\"src\"]').click()");
  await check(() => evaluate("Boolean(document.querySelector('.repository-entry[data-path=\"src/app.py\"]'))"), "展开目录后没有列出文件");
  await evaluate("document.querySelector('.repository-entry[data-path=\"src/app.py\"]').click()");
  await check(() => evaluate("document.querySelector('.editor-gutter').textContent.startsWith('1\\n2\\n3') && Boolean(document.querySelector('#repository-file-content .tok-keyword')) && Boolean(document.querySelector('#repository-file-content .tok-comment')) && document.querySelector('#repository-file-meta').textContent.includes('Python')"), "代码没有行号、高亮或语言信息");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#repository-file-content')).fontFamily"), await evaluate("getComputedStyle(document.querySelector('.editor-code')).fontFamily"), "代码没有使用编辑区的等宽字体");
  await evaluate("document.querySelector('.repository-entry[data-path=\"README.md\"]').click()");
  await check(() => evaluate("document.querySelectorAll('.editor-tab').length===2 && document.querySelector('.editor-tab[aria-selected=true]').title==='README.md' && document.querySelector('#repository-breadcrumbs').textContent.includes('README.md')"), "第二个文件没有在新标签打开");
  await evaluate("document.querySelector('.editor-tab[aria-selected=true] .editor-tab-close').click()");
  await check(() => evaluate("document.querySelectorAll('.editor-tab').length===1 && document.querySelector('.editor-tab[aria-selected=true]').title==='src/app.py'"), "关闭标签后没有切回上一个文件");
  await check(() => evaluate("[...document.querySelectorAll('.repository-entry .file-icon img,.editor-tab .file-icon img,.editor-crumb .file-icon img')].every(i=>i.complete&&i.naturalWidth>0) && document.querySelectorAll('.file-icon img').length>3"), "文件图标没有实际载入");
  const openedIcon = await evaluate("document.querySelector('.repository-entry[data-path=src] .file-icon').dataset.icon");
  await evaluate("document.querySelector('.repository-entry[data-path=src]').click()");
  assert.notEqual(await evaluate("document.querySelector('.repository-entry[data-path=src] .file-icon').dataset.icon"),openedIcon,"目录开闭没有切换图标");
  await evaluate("document.querySelector('.repository-entry[data-path=src]').click()");
  await captureLayouts(command, evaluate, "repository");
  const workspaceBindings = await verifyWorkspaceBinding(evaluate);
  await captureLayouts(command, evaluate, "workspace-chooser");
  const sidebarResize = await verifySidebarResize(command, evaluate, check);
  const { shots:collapseShots, ...sidebarCollapse } = await verifySidebarCollapse(command, evaluate, check, captureScreenshot);
  for (const shot of collapseShots) writeFileSync(join(directory, shot.name), Buffer.from(shot.data, "base64"));
  console.log("SIDEBAR_COLLAPSE_PASSED", collapseShots.map(shot => shot.name).join(" "));
  const zoomControls = await verifyZoomControls({ command, evaluate, check,
    main:expression=>evaluateMain(mainInspectorUrl,expression),
    capture:async name=>{ const shot=await captureScreenshot();writeFileSync(join(directory,name),Buffer.from(shot.data,"base64")); } });
  console.log("ZOOM_CONTROLS_PASSED", zoomControls.results.layouts.length);
  const { result:terminal, shots:terminalShots } = await verifyTerminal({ command, evaluate, check, screenshot:captureScreenshot,
    main:expression=>evaluateMain(mainInspectorUrl,expression) });
  for (const shot of terminalShots) writeFileSync(join(directory, shot.name), Buffer.from(shot.data, "base64"));
  console.log("TERMINAL_PASSED", terminalShots.map(shot => shot.name).join(" "));
  const { result:browser, shots:browserShots } = await verifyBrowser({ command, evaluate, check, screenshot:captureScreenshot,
    main:expression=>evaluateMain(mainInspectorUrl,expression) });
  for (const shot of browserShots) writeFileSync(join(directory, shot.name), Buffer.from(shot.data, "base64"));
  console.log("BROWSER_PASSED", browserShots.map(shot => shot.name).join(" "));
  const audit = await auditLayouts({ command, evaluate, check, main:expression=>evaluateMain(mainInspectorUrl,expression) });
  for (const shot of audit.shots) writeFileSync(join(directory, shot.name), Buffer.from(shot.data, "base64"));
  writeFileSync(join(directory, "layout-audit.json"), JSON.stringify(audit.results, null, 2));
  const layoutIssues = audit.results.filter(item => item.issues.length);
  assert.deepEqual(layoutIssues, [], `界面有错位或重叠（截图和 layout-audit.json 在 ${directory}）：${JSON.stringify(layoutIssues).slice(0, 3000)}`);
  console.log("LAYOUT_AUDIT_PASSED", audit.results.length);
  await command("Emulation.setDeviceMetricsOverride", { width:1280, height:820, deviceScaleFactor:1, mobile:false });
  const workspaceOrder = await verifyWorkspaceOrder(evaluate, check);
  const sidebarOrder = await verifySidebarOrder(evaluate, check);
  const imageInput = await verifyImageInput({command,evaluate,check,requests,directory,screenshot:captureScreenshot,
    main:expression=>evaluateMain(mainInspectorUrl,expression),
    captureLayouts:stage=>captureLayouts(command,evaluate,stage)});
  const fileAttachments = await verifyFileAttachments({command,evaluate,check,requests,directory,screenshot:captureScreenshot,
    captureLayouts:stage=>captureLayouts(command,evaluate,stage)});
  console.log("ATTACHMENTS_PASSED", JSON.stringify(fileAttachments));
  const rewind = await verifyRewind({ evaluate, check, requests });
  // 网页全屏会把隐藏的验收窗口显示出来，之后截图不稳定，所以放在最后。
  const browserFullscreen = await verifyBrowserFullscreen({ command, evaluate, check, main:expression=>evaluateMain(mainInspectorUrl,expression) });
  console.log("BROWSER_FULLSCREEN_PASSED");
  assert(await evaluate("!document.querySelector('#raw-result,.raw-section,.tool-raw,.event-payload')"), "正式界面仍包含原始结果或原始事件展示");
  await close();
  writeFileSync(join(directory, "result.json"), JSON.stringify({ passed: true, executable,
    independentPath: true, streamingBeforeCompletion: true, persistedEncryptedKey: true,
    allToolsCollapsible: true, noEmptyTextRows: true, userMessagesRightAligned: true, agentMessagesLeftAligned: true,
    messageBackgroundMatchesTheme: true, longMultilineMessagesContained: true, sidebarOrder,
    markdownRendering, workspaceOrder, sidebarResize, sidebarCollapse, zoomControls, terminal, browser, browserAgent, browserFullscreen, imageInput, fileAttachments, rewind,
    rawDebugDataAbsentFromUi:true,
    unauthorizedGatewayRejected: true, automaticLocalGateway: true, connectionStatusDotOnly: true, explicitNewChatWorkspace: true, workspaceBindings, noGatewayConnectionSettings: true, staleGatewayAddressIgnored: true, restartAndContinue: true, stopAndSteer: true, immediateStop: true, titlebarBorder: true, offlineRepositoryIcons: true, startupComposer: true, noDuplicateProfileTheme: true, windowsExecutableIcon: { orangePixels:windowsIcon.orange, whitePixels:windowsIcon.white, size:windowsIcon.size }, approvalBeforeWrite: true, diffAndUndo: true, memoryPanel: true, modelConnectionTest: true, gitCommit: true, sessionSearchRenameDelete: true, externalMcpTools: true, modelRequests: requests.length, state, uiLayouts:layoutResults,
  }, null, 2));
  console.log(`PACKAGED_ACCEPTANCE_PASSED ${directory}`);
} finally {
  for (const release of responseGates.values()) release();
  if (child) { try { await close(); } catch { child?.kill(); } }
  model.closeAllConnections(); await new Promise((done) => model.close(done));
}
