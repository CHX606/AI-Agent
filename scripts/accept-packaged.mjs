// 启动发布目录中的真正 exe。浏览器调试端口仅由本验收进程临时启用。
import { spawn } from "node:child_process";
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
const requests = [];
const model = createServer(async (request, response) => {
  let raw = ""; for await (const chunk of request) raw += String(chunk);
  const body = JSON.parse(raw); requests.push(body);
  const users = body.input.filter((item) => item.role === "user").map((item) => String(item.content));
  const text = `PACKAGED_STREAM_START ${users.join(" | ")} PACKAGED_STREAM_END`;
  const id = `resp-${requests.length}`;
  const message = { type: "message", id: `msg-${requests.length}`, status: "completed", role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }] };
    let output = [message];
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
          extraComposerRow:Boolean(document.querySelector('.composer-card .product-controls')) };
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
try {
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
  await evaluate(`document.querySelector('#workspace').value=${JSON.stringify(workspace)}; document.querySelector('#workspace').dispatchEvent(new Event('change')); document.querySelector('#objective').value='PACKAGE-CANARY-73'; document.querySelector('#run').click();`);
  await check(() => evaluate("document.body.dataset.busy==='true' && document.querySelector('#answer').textContent.includes('PACKAGED_STREAM_START')"), "最终完成之前没有收到流式文字");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='COMPLETED' && document.body.dataset.busy==='false' && !document.querySelector('#run').disabled"), "独立包未完成第一轮");
  const state = await evaluate("({ status:document.querySelector('#status').dataset.status, answer:document.querySelector('#answer').textContent, gateway:document.querySelector('#gateway').value })");
  assert(state.answer.includes("PACKAGE-CANARY-73"));
  const screenshot = await captureScreenshot();
  writeFileSync(join(directory, "packaged-desktop.png"), Buffer.from(screenshot.data, "base64"));
  await captureLayouts(command, evaluate, "conversation");
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
  await check(() => evaluate("document.body.dataset.busy === 'false' && !document.querySelector('#run').disabled && document.querySelector('#answer').textContent.includes('PACKAGE-CANARY-73')"), "历史回答没有恢复");
  await evaluate("document.querySelector('#objective').value='PACKAGE-FOLLOWUP';document.querySelector('#run').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='COMPLETED' && document.body.dataset.busy==='false' && !document.querySelector('#run').disabled && document.querySelector('#answer').textContent.includes('PACKAGE-FOLLOWUP')"), "重启后不能继续对话");
  assert(await evaluate("document.querySelector('#answer').textContent.includes('PACKAGE-CANARY-73')"));
  await evaluate("document.querySelector('#objective').value='PAUSE-TEST';document.querySelector('#run').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='RUNNING' && !document.querySelector('#pause-task').disabled"), "没有显示可用的暂停按钮");
  await evaluate("document.querySelector('#pause-task').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='PAUSED'"), "暂停未在安全位置生效");
  await captureLayouts(command, evaluate, "paused");
  await evaluate("document.querySelector('#intent-kind').value='replace';document.querySelector('#intent-input').value='CHANGED-INTENT';document.querySelector('#apply-intent').click()");
  await check(() => evaluate("document.querySelector('#status').dataset.status==='COMPLETED' && document.body.dataset.busy==='false' && !document.querySelector('#run').disabled && document.querySelector('#answer').textContent.includes('CHANGED-INTENT')"), "修改意图后没有重新执行");
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
  await captureLayouts(command, evaluate, "review");
  await evaluate("Array.from(document.querySelectorAll('.change-entry button')).find(button=>button.textContent==='撤销这次改动').click()");
  await check(async () => !existsSync(join(workspace, "package-demo.py")), "界面撤销没有恢复原文件状态");
  await close();
  writeFileSync(join(directory, "result.json"), JSON.stringify({ passed: true, executable,
    independentPath: true, streamingBeforeCompletion: true, persistedEncryptedKey: true,
    unauthorizedGatewayRejected: true, restartAndContinue: true, pauseAndSteer: true, approvalBeforeWrite: true, diffAndUndo: true, modelRequests: requests.length, state, uiLayouts:layoutResults,
  }, null, 2));
  console.log(`PACKAGED_ACCEPTANCE_PASSED ${directory}`);
} finally {
  if (child) { try { await close(); } catch { child?.kill(); } }
  model.closeAllConnections(); await new Promise((done) => model.close(done));
}
