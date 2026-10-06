import assert from "node:assert/strict";
import { createServer } from "node:http";

const pages = {
  "/": `<title>Fixture Home</title><body style="font:16px sans-serif;margin:24px">
    <h1>Browser fixture</h1><p><a id="next" href="/next">next page</a></p>
    <p><a id="popup" href="/popup" target="_blank" style="display:inline-block;padding:20px;background:#eee">open in new window</a></p>
    <p><a id="download" href="/file.txt">download</a></p></body>`,
  "/next": `<title>Fixture Next</title><body><p>browser-find-target</p><p>browser-find-target</p></body>`,
  "/popup": `<title>Fixture Popup</title><body>popup content</body>`,
};

function fixtureServer() {
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://x").pathname;
    if (path === "/file.txt") {
      response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=\"bit-agent-download.txt\"" });
      response.end("downloaded by the built-in browser");
      return;
    }
    const body = pages[path];
    response.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(body ?? "not found");
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const electron = "process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app/package.json')('electron')";
// 主进程里内置浏览器的原生视图（按独立会话识别）；view 是正在显示的那个标签页。
const viewExpression = (body) => `(async () => {
  const { BrowserWindow, session } = ${electron};
  const window = BrowserWindow.getAllWindows()[0];
  const views = window.contentView.children.filter(child => child.webContents?.session === session.fromPartition('persist:bit-agent-browser'));
  const view = views.find(child => child.getVisible()) ?? null;
  ${body}
})()`;

/** 内置浏览器：标签页、对齐、导航、弹窗遮挡、查找、缩放、下载、错误页、协议限制、视图切换、宽度、恢复、关闭。 */
export async function verifyBrowser({ command, evaluate, check, main, screenshot }) {
  const server = await fixtureServer();
  const host = `127.0.0.1:${server.address().port}`;
  const origin = `http://${host}`;
  const shots = [];
  const native = () => main(viewExpression(`return { visible:Boolean(view), bounds:view?.getBounds() ?? null, url:view?.webContents.getURL() ?? null,
    title:view?.webContents.getTitle() ?? null, zoom:view?.webContents.getZoomFactor() ?? null, tabs:views.length,
    loaded:views.map(child => child.webContents.getURL()), windows:BrowserWindow.getAllWindows().length };`));
  const title = async () => (await native()).title;
  const inPage = (script, gesture = false) => main(viewExpression(`return view.webContents.executeJavaScript(${JSON.stringify(script)}, ${gesture});`));
  // 带用户手势执行点击：验收窗口是隐藏的，鼠标事件到不了网页；没有用户手势的跳转会被 Chromium 标记为“后退时跳过”，
  // target=_blank 也会被拦截。
  const clickInPage = (selector) => inPage(`document.querySelector(${JSON.stringify(selector)}).click()`, true);
  const stage = () => evaluate(`(() => { const r=document.querySelector('#browser-pane .browser-stage').getBoundingClientRect();
    return { x:Math.round(r.left), y:Math.round(r.top), width:Math.round(r.width), height:Math.round(r.height) }; })()`);
  const aligned = async () => {
    const [view, rect] = [await native(), await stage()];
    return view.visible && ["x", "y", "width", "height"].every(key => Math.abs(view.bounds[key] - rect[key]) <= 1);
  };
  const ui = (expression) => evaluate(`(() => { const pane=document.querySelector('#browser-pane'); return ${expression}; })()`);
  const tabs = () => ui("[...pane.querySelectorAll('.browser-tab')].map(tab => ({ title:tab.querySelector('.browser-tab-title').textContent, active:tab.getAttribute('aria-selected')==='true' }))");
  const go = async (text) => evaluate(`(() => { const form=document.querySelector('#browser-pane .browser-address');
    form.querySelector('input').value=${JSON.stringify(text)}; form.requestSubmit(); })()`);
  const key = (init) => evaluate(`(() => { const pane=document.querySelector('#browser-pane'); pane.querySelector('.browser-address input').focus();
    pane.dispatchEvent(new KeyboardEvent('keydown', { bubbles:true, ...${JSON.stringify(init)} })); })()`);
  const downloads = await main(`(() => { const { app } = ${electron}; const { mkdtempSync } = process.getBuiltinModule('fs');
    const { join } = process.getBuiltinModule('path'); const { tmpdir } = process.getBuiltinModule('os');
    globalThis.browserAcceptanceDownloads = app.getPath('downloads');
    const directory = mkdtempSync(join(tmpdir(), 'bit-agent-downloads-')); app.setPath('downloads', directory); return directory; })()`);
  try {
    // 用窗口真实尺寸：原生视图的坐标是窗口坐标，不受页面模拟尺寸影响。
    await command("Emulation.clearDeviceMetricsOverride", {});
    await evaluate("document.querySelector('#nav-tasks').click()");
    const inspectorBefore = await evaluate("document.querySelector('.shell').dataset.inspectorCollapsed");
    await evaluate("document.querySelector('#browser-toggle').click()");
    await check(() => ui("document.activeElement===pane.querySelector('.browser-address input')"), "打开浏览器后地址栏没有获得焦点");
    const opened = await evaluate(`({ open:document.querySelector('.shell').dataset.browserOpen, start:!document.querySelector('#browser-pane .browser-start').hidden,
      inspectorHidden:getComputedStyle(document.querySelector('.sidebar-right')).display==='none',
      browserActive:document.querySelector('#browser-toggle').classList.contains('is-active'),
      terminalActive:document.querySelector('#terminal-toggle').classList.contains('is-active') })`);
    assert.deepEqual(opened, { open:"true", start:true, inspectorHidden:true, browserActive:true, terminalActive:false },
      `打开浏览器的状态不对：${JSON.stringify(opened)}`);
    await check(() => ui("pane.querySelector('.browser-servers').dataset.state!=='loading'"), "本机服务检测没有结束");

    await go(host);
    await check(async () => await title() === "Fixture Home", "地址栏导航没有打开测试页");
    await check(aligned, "原生网页视图没有对齐浏览器区域");
    assert.equal(await ui("pane.querySelector('.browser-address input').value"), host);
    await check(async () => JSON.stringify(await tabs()) === JSON.stringify([{ title:"Fixture Home", active:true }]), "标签栏没有显示网页标题");
    shots.push({ name:"browser-open.png", data:(await screenshot()).data });

    await clickInPage("#next");
    await check(async () => await title() === "Fixture Next", "页面内链接没有打开");
    await check(() => ui("!pane.querySelector('[data-action=back]').disabled"), "后退按钮没有启用");
    await ui("pane.querySelector('[data-action=back]').click()");
    await check(async () => await title() === "Fixture Home", "后退没有回到上一页");
    await ui("pane.querySelector('[data-action=forward]').click()");
    await check(async () => await title() === "Fixture Next", "前进没有回到下一页");
    await ui("pane.querySelector('[data-action=back]').click()");
    await check(async () => await title() === "Fixture Home", "后退没有回到首页");

    // target=_blank：在新标签页打开并切换过去，不弹出独立窗口。
    await clickInPage("#popup");
    await check(async () => await title() === "Fixture Popup", "新窗口链接没有在新标签页打开");
    assert.deepEqual(await tabs(), [{ title:"Fixture Home", active:false }, { title:"Fixture Popup", active:true }]);
    assert.equal((await native()).windows, 1, "新窗口链接弹出了独立窗口");
    await check(aligned, "切到新标签页后原生视图没有对齐");

    // 新建标签页：显示起始页、原生视图隐藏；在里面打开网页；关闭后回到右边/左边的标签页。
    await ui("pane.querySelector('.browser-new-tab').click()");
    await check(async () => (await tabs()).length === 3 && !(await native()).visible
      && await ui("!pane.querySelector('.browser-start').hidden && document.activeElement===pane.querySelector('.browser-address input')"),
    "新建标签页没有显示起始页");
    await go(`${origin}/next`);
    await check(async () => await title() === "Fixture Next", "新标签页没有打开网页");
    await key({ key:"w", ctrlKey:true });
    await check(async () => (await tabs()).length === 2 && await title() === "Fixture Popup", "Ctrl+W 没有关闭标签页并回到上一个");
    await key({ key:"Tab", ctrlKey:true });
    await check(async () => await title() === "Fixture Home", "Ctrl+Tab 没有切换到下一个标签页");
    await ui("pane.querySelectorAll('.browser-tab')[1].click()");
    await check(async () => await title() === "Fixture Popup", "点击标签没有切换");

    // 对话里的链接在新标签页打开。
    await evaluate(`(() => { const link=document.createElement('a'); link.id='acceptance-link'; link.href=${JSON.stringify(`${origin}/next`)};
      link.target='_blank'; link.textContent='link'; document.querySelector('#conversation').append(link); link.click(); link.remove(); })()`);
    await check(async () => (await tabs()).length === 3 && await title() === "Fixture Next", "对话里的链接没有在内置浏览器的新标签页打开");

    // 缩放：Ctrl+= 放大，地址栏显示比例，点击恢复。
    await key({ key:"=", ctrlKey:true });
    await check(async () => (await native()).zoom === 1.1 && await ui("pane.querySelector('.browser-zoom').textContent==='110%' && !pane.querySelector('.browser-zoom').hidden"),
      "Ctrl+= 没有放大页面或没有显示比例");
    await ui("pane.querySelector('.browser-zoom').click()");
    await check(async () => (await native()).zoom === 1 && await ui("pane.querySelector('.browser-zoom').hidden"), "点击比例没有恢复到 100%");

    // 页内查找。页面没有被合成（隐藏窗口）时 Chromium 不返回查找结果；这时只验证查找栏走通（显示“无结果”）。
    const rendering = await main(`(() => { const { BrowserWindow } = ${electron}; const window = BrowserWindow.getAllWindows()[0];
      return window.isVisible() && !window.isMinimized(); })()`);
    console.log("BROWSER_RENDERING", rendering);
    await key({ key:"f", ctrlKey:true });
    await ui("(() => { const input=pane.querySelector('.browser-find input'); input.value='browser-find-target'; input.dispatchEvent(new Event('input')); })()");
    const expectedCount = rendering ? "1/2" : "无结果";
    await check(() => ui(`pane.querySelector('.browser-find-count').textContent===${JSON.stringify(expectedCount)}`), "页内查找结果不对");
    await ui("pane.querySelector('.browser-find input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    assert.equal(await ui("pane.querySelector('.browser-find').hidden"), true, "Esc 没有关闭查找栏");
    await check(aligned, "查找栏关闭后原生视图没有对齐");

    // 弹窗出现在浏览器上方时：原生视图隐藏（窗口可见时换成截图）；关闭后恢复。
    await evaluate("document.querySelector('#mcp-settings').click()");
    await check(async () => !(await native()).visible, "弹窗打开时原生视图没有隐藏");
    await check(() => ui(`(() => { const img=pane.querySelector('.browser-snapshot');
      return ${rendering} ? !img.hidden && img.src.startsWith('data:image/jpeg') : img.hidden; })()`),
      rendering ? "弹窗遮挡时没有显示网页截图" : "截图不可用时仍显示了截图");
    shots.push({ name:"browser-occluded.png", data:(await screenshot()).data });
    await evaluate("document.querySelector('.product-dialog[open] .product-dialog-header .icon-button').click()");
    await check(aligned, "弹窗关闭后原生视图没有恢复");
    await check(() => ui("pane.querySelector('.browser-snapshot').hidden"), "视图恢复后截图没有移除");

    // 下载：存到下载目录（验收时换成临时目录），下载栏显示完成和“打开 / 在文件夹中显示”。
    await ui("pane.querySelectorAll('.browser-tab')[0].click()");
    await check(async () => await title() === "Fixture Home", "没有切回首页标签");
    await clickInPage("#download");
    await check(() => ui("(() => { const item=pane.querySelector('.browser-download'); return item?.dataset.state==='completed'; })()"), "下载没有完成");
    const download = await ui(`(() => { const item=pane.querySelector('.browser-download');
      return { name:item.querySelector('strong').textContent, path:item.querySelector('strong').title,
        open:!item.querySelector('[data-download=open]').hidden, show:!item.querySelector('[data-download=show]').hidden }; })()`);
    assert.deepEqual({ ...download, path:undefined }, { name:"bit-agent-download.txt", open:true, show:true, path:undefined });
    const saved = await main(`process.getBuiltinModule('fs').readFileSync(${JSON.stringify(download.path)}, 'utf8')`);
    assert.equal(saved, "downloaded by the built-in browser", "下载的文件内容不对");
    assert(download.path.startsWith(downloads), `下载没有存到下载目录：${download.path}`);
    await check(aligned, "下载栏出现后原生视图没有对齐");
    const layout = await ui(`(() => { const box=element=>element.getBoundingClientRect();
      const [panel, stageBox, bar]=[box(pane), box(pane.querySelector('.browser-stage')), box(pane.querySelector('.browser-downloads'))];
      return { barAtBottom:Math.abs(bar.bottom-panel.bottom)<=1, stageAboveBar:Math.abs(stageBox.bottom-bar.top)<=1 }; })()`);
    assert.deepEqual(layout, { barAtBottom:true, stageAboveBar:true }, `下载栏没有贴在底部：${JSON.stringify(layout)}`);
    shots.push({ name:"browser-download.png", data:(await screenshot()).data });

    // 打不开的地址：显示易懂的错误页，原生视图隐藏。
    await go("127.0.0.1:1");
    await check(() => ui("!pane.querySelector('.browser-error').hidden"), "连接失败时没有显示错误页");
    assert.equal((await native()).visible, false, "错误页时原生视图仍然显示");
    assert.equal(await ui("pane.querySelector('.browser-error-detail').textContent"), "出于安全原因，浏览器不允许访问这个端口。", "错误页没有给出易懂的说明");
    shots.push({ name:"browser-error.png", data:(await screenshot()).data });

    // 只允许 http/https。
    const before = (await native()).loaded;
    await go("file:///C:/Windows/win.ini");
    assert.equal(await ui("pane.querySelector('.browser-address input').validationMessage"), "只能打开 http 或 https 地址");
    assert.deepEqual((await native()).loaded, before, "file: 地址被打开了");

    // 回到正常页面，切换视图、调整宽度。
    await go(`${origin}/`);
    await check(aligned, "错误后重新导航没有恢复视图");
    await evaluate("document.querySelector('#nav-repository').click()");
    await check(async () => !(await native()).visible, "切到代码仓库页后原生视图没有隐藏");
    await evaluate("document.querySelector('#nav-tasks').click()");
    await check(aligned, "切回对话页后原生视图没有恢复");
    // 先变窄再恢复：窗口不宽时变宽会碰到“对话区至少 420px”的上限。
    const widthBefore = (await stage()).width;
    await ui("pane.querySelector('.browser-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true}))");
    await check(async () => Math.abs((await stage()).width - (widthBefore - 80)) <= 2 && await aligned(), "调整宽度后原生视图没有跟上");
    await ui("pane.querySelector('.browser-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',shiftKey:true,bubbles:true}))");
    await check(async () => Math.abs((await stage()).width - widthBefore) <= 2 && await aligned(), "恢复宽度后原生视图没有跟上");

    // 应用页面重新加载：原生视图先隐藏，重新打开后接上原来的标签页，不重复恢复。
    const tabsBefore = (await tabs()).length;
    await evaluate("location.reload()");
    await check(() => evaluate("document.readyState==='complete' && Boolean(window.bitAgent && document.querySelector('#browser-toggle'))"), "页面没有重新加载");
    await check(async () => !(await native()).visible, "页面重新加载后原生视图仍盖在页面上");
    await evaluate("document.querySelector('#nav-tasks').click(); document.querySelector('#browser-toggle').click()");
    await check(async () => (await tabs()).length === tabsBefore && (await native()).tabs === tabsBefore && await aligned(),
      "重新加载后没有接上原来的标签页");

    // 应用重启后的恢复：主进程里没有标签页时，从记录里恢复；只加载当前那个。
    while ((await tabs()).length) await ui("pane.querySelector('.browser-tab .browser-tab-close').click()").then(() => new Promise(resolve => setTimeout(resolve, 100)));
    await check(async () => (await native()).tabs === 0, "关闭所有标签页后原生视图没有释放");
    await evaluate(`localStorage.setItem('bit-agent.browser-tabs.v1', JSON.stringify({ tabs:[{ url:${JSON.stringify(`${origin}/`)}, title:"Saved Home" },
      { url:${JSON.stringify(`${origin}/next`)}, title:"Saved Next" }], active:1 }))`);
    await evaluate("location.reload()");
    await check(() => evaluate("document.readyState==='complete' && Boolean(window.bitAgent && document.querySelector('#browser-toggle'))"), "页面没有重新加载");
    await evaluate("document.querySelector('#nav-tasks').click(); document.querySelector('#browser-toggle').click()");
    await check(async () => await title() === "Fixture Next" && (await tabs()).length === 2, "没有从记录里恢复标签页");
    const restoredTabs = await tabs();
    assert.deepEqual(restoredTabs, [{ title:"Saved Home", active:false }, { title:"Fixture Next", active:true }], "恢复的标签页不对");
    assert.deepEqual((await native()).loaded, ["", `${origin}/next`], "恢复时加载了不在前台的标签页");
    await ui("pane.querySelectorAll('.browser-tab')[0].click()");
    await check(async () => await title() === "Fixture Home", "切换到恢复的标签页时没有加载");

    await ui("pane.querySelector('[data-action=close]').click()");
    await check(async () => !(await native()).visible, "关闭后原生视图没有隐藏");
    const closed = await evaluate(`({ open:document.querySelector('.shell').dataset.browserOpen,
      inspector:document.querySelector('.shell').dataset.inspectorCollapsed })`);
    assert.deepEqual(closed, { open:"false", inspector:inspectorBefore }, "关闭浏览器后右侧没有恢复原状");
    return { result:{ tabs:true, aligned:true, navigation:true, newWindowAsTab:true, conversationLinks:true, zoom:true, find:true,
      occlusion:true, download:true, errorPage:true, httpOnly:true, hiddenInRepositoryView:true, resizeFollows:true,
      survivesPageReload:true, restoresTabsLazily:true, closeRestoresInspector:true, rendering }, shots };
  } finally {
    await main(`(() => { const { app } = ${electron}; const { rmSync } = process.getBuiltinModule('fs');
      rmSync(${JSON.stringify(downloads)}, { recursive:true, force:true });
      if (globalThis.browserAcceptanceDownloads) app.setPath('downloads', globalThis.browserAcceptanceDownloads); })()`).catch(() => {});
    await evaluate("['bit-agent.browser-recent.v1','bit-agent.browser-width.v1','bit-agent.browser-tabs.v1'].forEach(key => localStorage.removeItem(key))").catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
}
