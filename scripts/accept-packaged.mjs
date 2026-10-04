// 启动发布目录中的真正 exe。浏览器调试端口仅由本验收进程临时启用。
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const executable = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("需要提供待验收的 exe 路径");
const root = resolve(import.meta.dirname, "..");
const directory = mkdtempSync(join(root, "tmp", "packaged-acceptance-"));
console.log("PACKAGED_ACCEPTANCE_DIRECTORY", directory);
const workspace = join(directory, "workspace"); mkdirSync(workspace);
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
const model = createServer(async (request, response) => {
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
  const users = body.input.filter((item) => item.role === "user").map((item) => String(item.content));
  const text = `PACKAGED_STREAM_START ${users.join(" | ")} PACKAGED_STREAM_END`;
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
  await new Promise((done) => setTimeout(done, 1800));
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
        const sample = await window.webContents.executeJavaScript("(() => { const element = document.querySelector('.product-dialog[open]') || document.querySelector('.composer-card'); const rect = element.getBoundingClientRect(); return { x:rect.right-16, y:rect.top+16, width:innerWidth, height:innerHeight, color:getComputedStyle(element).backgroundColor.match(/\\\\d+/g).slice(0,3).map(Number) }; })()");
        // 隐藏窗口的第一张截图可能仍是上一帧。实际像素必须与当前主题一致。
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
          if (color.every((value, index) => Math.abs(value - sample.color[index]) < 12)) {
            return { data:image.toPNG().toString('base64'), pixelThemeChecked:true };
          }
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        throw new Error('截图画面没有更新到当前主题');
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
  if (process.env.BIT_AGENT_LAYOUT_STAGE && process.env.BIT_AGENT_LAYOUT_STAGE !== stage) return;
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
        return { card:rect('.composer-card'), context:rect('.composer-context'), actions:rect('.composer-actions'),
          interaction:rect('#task-interaction'), dialog:rect('.product-dialog[open]'),
          dialogBackground:document.querySelector('.product-dialog[open]') ? getComputedStyle(document.querySelector('.product-dialog[open]')).backgroundColor : null,
          settingsInSidebar:Boolean(document.querySelector('#model-settings').closest('.sidebar-bottom')),
          permissionInToolbar:Boolean(document.querySelector('#permission-mode').closest('.composer-toolbar')),
          reviewInInspector:Boolean(document.querySelector('#review-changes').closest('.inspector-heading')),
          extraComposerRow:Boolean(document.querySelector('.composer-card .product-controls')),
          menu:rect('.choice-popover:not([hidden])') };
      })()`);
      assert(geometry.settingsInSidebar && geometry.permissionInToolbar && geometry.reviewInInspector && !geometry.extraComposerRow, "新入口不在约定的位置");
      const inside = r => r && r.x >= -1 && r.y >= -1 && r.right <= width + 1 && r.bottom <= height + 1;
      assert(inside(geometry.card), `${filename}: 输入框超出窗口`);
      assert(geometry.card.overflow <= 1, `${filename}: 输入框出现横向溢出`);
      const { context, actions } = geometry;
      assert(context.right <= actions.x + 1 || context.bottom <= actions.y + 1 || actions.bottom <= context.y + 1, `${filename}: 底栏控件相互遮挡`);
      if (geometry.interaction) {
        assert(inside(geometry.interaction), `${filename}: 问答卡片超出窗口`);
        assert(geometry.interaction.bottom <= geometry.card.y + 1, `${filename}: 问答卡片侵入输入框`);
      }
      if (geometry.menu) assert(inside(geometry.menu), `${filename}: 选择菜单超出窗口`);
      if (geometry.dialog) {
        assert(inside(geometry.dialog), `${filename}: 弹窗超出窗口`);
        assert(Math.abs(geometry.dialog.x + geometry.dialog.width / 2 - width / 2) <= 2, `${filename}: 弹窗没有居中`);
        assert.equal(geometry.dialogBackground, theme === "dark" ? "rgb(28, 28, 26)" : "rgb(255, 255, 255)", `${filename}: 弹窗没有使用当前主题`);
      }
      layoutResults.push({ stage, theme, width, height, screenshot:filename, pixelThemeChecked:shot.pixelThemeChecked, geometry });
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
  const configuration = await evaluate("window.bitAgent.runtimeConfig");
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
  await evaluate(`document.querySelector('#workspace').value=${JSON.stringify(workspace)}; document.querySelector('#workspace').dispatchEvent(new Event('change')); document.querySelector('#objective').value='PACKAGE-CANARY-73'; document.querySelector('#run').click();`);
  await check(() => evaluate("document.body.dataset.busy==='true' && document.querySelector('#current-turn').textContent.includes('PACKAGED_STREAM_START')"), "最终完成之前没有收到流式文字");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='COMPLETED' && document.body.dataset.busy==='false' && !document.querySelector('#run').disabled"), "独立包未完成第一轮");
  const state = await evaluate("({ status:document.querySelector('#status').dataset.status, answer:document.querySelector('#current-turn').textContent, gateway:document.querySelector('#gateway').value })");
  assert(state.answer.includes("PACKAGE-CANARY-73"));
  const screenshot = await captureScreenshot();
  writeFileSync(join(directory, "packaged-desktop.png"), Buffer.from(screenshot.data, "base64"));
  await captureLayouts(command, evaluate, "conversation");
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
  await evaluate("document.querySelector('.model-settings-form').requestSubmit()");
  await check(() => evaluate("Boolean(document.querySelector('.product-feedback[data-kind=success]'))"), "设置表单无法保存");
  await evaluate("document.querySelector('.product-dialog-header button').click()");
  await close();
  ({ command, evaluate } = await launch());
  await check(() => evaluate("Array.from(document.querySelectorAll('.history-item')).some(button=>button.title==='PACKAGE-CANARY-73')"), "重启后没有恢复已存会话");
  await evaluate("Array.from(document.querySelectorAll('.history-item')).find(button=>button.title==='PACKAGE-CANARY-73').click()");
  await check(() => evaluate("document.body.dataset.busy === 'false' && !document.querySelector('#run').disabled && document.querySelector('#current-turn').textContent.includes('PACKAGE-CANARY-73')"), "历史回答没有恢复");
  await evaluate("document.querySelector('#objective').value='PACKAGE-FOLLOWUP';document.querySelector('#run').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='COMPLETED' && document.body.dataset.busy==='false' && !document.querySelector('#run').disabled && document.querySelector('#current-turn').textContent.includes('PACKAGE-FOLLOWUP')"), "重启后不能继续对话");
  const followup = await evaluate("document.querySelector('#current-turn').textContent");
  assert(followup.includes("PACKAGE-CANARY-73"), `继续对话的回答没有带上前一轮：${followup}`);
  await evaluate("document.querySelector('#objective').value='PAUSE-TEST';document.querySelector('#run').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='RUNNING' && !document.querySelector('#pause-task').disabled"), "没有显示可用的暂停按钮");
  await evaluate("document.querySelector('#pause-task').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='PAUSED'"), "暂停未在安全位置生效");
  await captureLayouts(command, evaluate, "paused");
  await evaluate("document.querySelector('#intent-input').value='CHANGED-INTENT';document.querySelector('#apply-intent').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='COMPLETED' && document.body.dataset.busy==='false' && !document.querySelector('#run').disabled && document.querySelector('#current-turn').textContent.includes('CHANGED-INTENT')"), "修改意图后没有重新执行");
  // 像 Claude Code 一样：暂停后直接在主输入框写补充要求，按 Enter 继续。
  // 运行中直接在输入框补充要求：先排队，Agent 下一步读取，最终回答里能看到。
  await evaluate("document.querySelector('#objective').value='RUN-NOTE-TEST';document.querySelector('#run').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='RUNNING' && !document.querySelector('#objective').disabled"), "运行中输入框不能补充要求");
  await evaluate("const r=document.querySelector('#objective');r.value='RUNNING-NOTE';r.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='COMPLETED' && document.body.dataset.busy==='false' && document.querySelector('#stream .stream-user')?.textContent.includes('RUNNING-NOTE') && [...document.querySelectorAll('#stream .stream-text')].some(e=>e.textContent.includes('RUNNING-NOTE'))"), "运行中补充的要求没有被 Agent 读到");
  assert(await evaluate("[...document.querySelectorAll('.saved-turn .stream-note')].some(e=>e.textContent.includes('暂停'))"), "继续对话后上一轮的执行过程不见了");
  await evaluate("document.querySelector('#objective').value='PAUSE-AGAIN';document.querySelector('#run').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='RUNNING'"), "第二次暂停测试没有开始运行");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='PAUSED' && !document.querySelector('#objective').disabled && !document.querySelector('#run').disabled"), "Esc 暂停后输入框不能写补充要求");
  await evaluate("const o=document.querySelector('#objective');o.value='COMPOSER-NOTE';o.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='COMPLETED' && document.body.dataset.busy==='false' && document.querySelector('#stream .stream-user')?.textContent.includes('COMPOSER-NOTE') && document.querySelector('#objective').value===''"), "输入框补充要求没有提交并继续");
  await evaluate("document.querySelector('#objective').value='PACKAGE-EDIT';document.querySelector('#run').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='WAITING_FOR_INPUT' && !document.querySelector('.operation-details').hidden"), "文件修改没有要求用户授权");
  const { existsSync } = await import("node:fs");
  assert(!existsSync(join(workspace, "package-demo.py")));
  await captureLayouts(command, evaluate, "approval");
  await evaluate("document.querySelector('input[name=agent-question-option][value=approve]').click();document.querySelector('#submit-question-answer').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='WAITING_FOR_INPUT' && document.querySelector('.question-title').textContent.includes('等待审阅')"), "批准后工具未执行或问题卡片未更新");
  assert(existsSync(join(workspace, "package-demo.py")));
  await evaluate("document.querySelector('#cancel').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='CANCELLED' && document.body.dataset.busy==='false'"), "等待回答时不能取消");
  await evaluate("document.querySelector('#review-changes').click()");
  await check(() => evaluate("Boolean(document.querySelector('.change-entry pre')?.textContent.includes('package fixture'))"), "审阅界面没有显示真实差异");
  await check(() => evaluate("Boolean(document.querySelector('.git-commit .git-files')?.textContent.includes('package-demo.py'))"), "提交面板没有列出任务改过的文件")
    .catch(async (error) => { throw new Error(`${await evaluate("document.querySelector('.product-dialog')?.innerText ?? ''")}\n${error.message}`); });
  await captureLayouts(command, evaluate, "review");
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
  await evaluate("document.querySelector('#new-task').click()");
  await evaluate("document.querySelector('#objective').value='PACKAGE-MCP';document.querySelector('#run').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='WAITING_FOR_INPUT' && document.querySelector('.question-title').textContent.includes('调用外部工具 self · list_files')"), "调用外部工具前没有要求确认");
  await evaluate("document.querySelector('input[name=agent-question-option][value=approve]').click();document.querySelector('#submit-question-answer').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='COMPLETED' && document.body.dataset.busy==='false'"), "批准后外部工具任务没有完成");
  const mcpTask = await evaluate("(async()=>{const h=JSON.parse(localStorage.getItem('bit-agent.task-history.v1'));const t=h[0];return window.bitAgent.getResult({gatewayUrl:t.gatewayUrl,taskId:t.taskId});})()");
  assert.equal(mcpTask.result.final_answer, "PACKAGE-MCP-DONE", JSON.stringify(mcpTask.result.final_answer));
  assert.equal(mcpTask.result.tool_calls[0].tool_name, "mcp__self__list_files");
  assert(JSON.stringify(mcpTask.result.tool_calls[0].output).includes("README.md"), "外部工具没有返回工作区文件列表");
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
  await search("CHANGED-INTENT");
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
  // 重新打开多轮对话：更早的轮次只显示回答，点“查看执行过程”回放那一轮。
  await evaluate("document.querySelector('.history-item').click()");
  await check(() => evaluate("document.body.dataset.busy==='false' && document.querySelectorAll('.saved-turn .turn-expand').length>0"), "旧轮次没有“查看执行过程”入口");
  await evaluate("document.querySelector('.saved-turn .turn-expand').click()");
  await check(() => evaluate("(()=>{const t=document.querySelector('.saved-turn');return !t.querySelector('.turn-expand') && Boolean(t.querySelector('.stream-text')?.textContent.includes('PACKAGED_STREAM_START'));})()"), "点开后没有回放旧轮次的过程");
  await close();
  writeFileSync(join(directory, "result.json"), JSON.stringify({ passed: true, executable,
    independentPath: true, streamingBeforeCompletion: true, persistedEncryptedKey: true,
    unauthorizedGatewayRejected: true, restartAndContinue: true, pauseAndSteer: true, approvalBeforeWrite: true, diffAndUndo: true, memoryPanel: true, modelConnectionTest: true, gitCommit: true, sessionSearchRenameDelete: true, externalMcpTools: true, modelRequests: requests.length, state, uiLayouts:layoutResults,
  }, null, 2));
  console.log(`PACKAGED_ACCEPTANCE_PASSED ${directory}`);
} finally {
  if (child) { try { await close(); } catch { child?.kill(); } }
  model.closeAllConnections(); await new Promise((done) => model.close(done));
}
