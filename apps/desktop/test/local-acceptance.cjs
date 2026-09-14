// 启动真实 Electron 页面和 preload；所有数据使用独立验收目录，不碰用户偏好。
const { app, dialog } = require("electron");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { writeFileSync, mkdirSync } = require("node:fs");
const output = process.env.ACCEPTANCE_OUTPUT;
const profile = join(output, "electron-profile");
mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.disableHardwareAcceleration();
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.env.ACCEPTANCE_WORKSPACE] });
const watchdog = setTimeout(() => { console.error("Electron 验收超时"); app.exit(1); }, 40000);
const errors = [];

app.once("browser-window-created", (_event, window) => {
  window.show = () => {}; // 自动验收不抢占用户正在使用的窗口。
  window.webContents.setBackgroundThrottling(false);
  window.webContents.on("console-message", (event) => {
    const details = event.details ?? event;
    if (details.level === "error" || details.level >= 3) errors.push(details.message);
  });
  window.webContents.once("did-finish-load", () => {
    run(window).then(() => {
      console.log("DESKTOP_ACCEPTANCE_PASSED");
      clearTimeout(watchdog);
      app.exit(0);
    }).catch((error) => {
      console.error(error.stack || error);
      console.error(JSON.stringify(errors));
      clearTimeout(watchdog);
      app.exit(1);
    });
  });
});

async function run(window) {
  const js = (source) => window.webContents.executeJavaScript(source, true);
  const check = (value, message) => { if (!value) throw new Error(message); };
  const wait = async (expression, message) => {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (await js(expression)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`${message}: ${await js("document.querySelector('#answer').textContent")}`);
  };
  const send = async (text, mode) => {
    const previousTask = await js("document.querySelector('#task-id').textContent");
    await js(`document.querySelector('#agent-mode').value=${JSON.stringify(mode)}; document.querySelector('#agent-mode').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#objective').value=${JSON.stringify(text)}; document.querySelector('#run').click();`);
    await wait(`document.querySelector('#task-id').textContent!==${JSON.stringify(previousTask)} && document.body.dataset.busy === 'false' && document.querySelector('#status').dataset.status === 'COMPLETED' && document.querySelector('#answer').textContent.includes(${JSON.stringify(text)})`, "新一轮任务未完成");
  };
  await js(`document.querySelector('#gateway').value=${JSON.stringify(process.env.ACCEPTANCE_GATEWAY)}; document.querySelector('#gateway').dispatchEvent(new Event('change')); document.querySelector('#health').click();`);
  await wait("document.querySelector('#connection').dataset.connected === 'true'", "Gateway 未连接");
  await js("document.querySelector('#browse').click()");
  await wait(`document.querySelector('#workspace').value===${JSON.stringify(process.env.ACCEPTANCE_WORKSPACE)}`, "文件夹选择未传入页面");
  await send("desktop first", "off");
  check(await js("document.querySelector('#agent-mode').value==='off'"), "关闭模式状态错误");
  await send("desktop followup", "auto");
  check(await js("document.querySelector('#answer').textContent.includes('desktop first')"), "第二轮丢失第一轮上下文");
  check(await js("document.querySelectorAll('#previous-turns .saved-turn').length===1"), "旧轮次没有展示");
  // 等待实际绘制，避免隐藏窗口截图仍停留在上一帧。
  await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  const snapshot = await js("({status: document.querySelector('#status').dataset.status, answer: document.querySelector('#answer').textContent, previousTurns: document.querySelectorAll('#previous-turns .saved-turn').length})");
  writeFileSync(join(output, "desktop-state.json"), JSON.stringify(snapshot, null, 2));
  const screenshot = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  writeFileSync(join(output, "desktop-acceptance.png"), screenshot.toPNG());

  await js(`document.querySelector('#workspace').value=${JSON.stringify(process.env.ACCEPTANCE_OTHER)}; document.querySelector('#workspace').dispatchEvent(new Event('change'));`);
  check(await js("document.querySelector('#task-id').textContent==='新任务'"), "手工切换目录没有新建对话");
  await send("desktop different folder", "on");
  check(await js("!document.querySelector('#answer').textContent.includes('desktop first')"), "不同目录的对话混入旧上下文");
  check(await js("document.querySelector('#agent-mode').value==='on'"), "开启模式状态错误");

  // 清除标题缓存后重载，证明会话来自 SQLite，而不只是浏览器缓存。
  await js("localStorage.removeItem('bit-agent.task-history.v1')");
  await new Promise((done) => { window.webContents.once("did-finish-load", done); window.webContents.reload(); });
  await wait("Array.from(document.querySelectorAll('.history-item')).some(button => button.title === 'desktop first')", "重新加载后没有恢复会话列表");
  await js("Array.from(document.querySelectorAll('.history-item')).find(button => button.title === 'desktop first').click()");
  await wait("document.body.dataset.busy==='false' && document.querySelector('#answer').textContent.includes('desktop followup')", "历史会话不能恢复");
  check(await js("document.querySelectorAll('#previous-turns .saved-turn').length===1"), "恢复后旧消息缺失");
  check(errors.length === 0, `页面出现错误：${errors.join('; ')}`);
}

import(pathToFileURL(join(process.env.ACCEPTANCE_ROOT, "apps/desktop/dist/main/main/main.js")).href)
  .catch((error) => { console.error(error); app.exit(1); });
