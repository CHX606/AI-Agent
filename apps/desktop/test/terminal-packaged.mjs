import assert from "node:assert/strict";

// 当前显示的那个终端（可以有多个标签页）。
const current = "#terminal-panel .terminal-session:not([hidden])";
// 带括号：拼进 `${rows}.includes(...)` 和 `!${rows}` 时优先级才对。
const rows = `(document.querySelector('${current} .xterm-rows')?.textContent ?? '')`;
const lineList = `[...document.querySelectorAll('${current} .xterm-rows > div')].map(row=>row.textContent.trim())`;

async function key(command, init) {
  for (const type of ["keyDown", "keyUp"]) await command("Input.dispatchKeyEvent", { type, ...init });
}

async function typeLine(command, evaluate, text) {
  await evaluate(`document.querySelector('${current} .xterm-helper-textarea').focus()`);
  await command("Input.insertText", { text });
  for (const type of ["keyDown", "keyUp"]) {
    await command("Input.dispatchKeyEvent", { type, key:"Enter", code:"Enter", windowsVirtualKeyCode:13, ...(type === "keyDown" ? { text:"\r" } : {}) });
  }
}

/** 内置终端：打开、运行命令、配色生效（CSP 下的样式镜像）、隐藏后保留、重新启动。 */
export async function verifyTerminal({ command, evaluate, check, screenshot, main }) {
  const shots = [];
  const capture = async (name) => {
    await new Promise(resolve => setTimeout(resolve, 200));
    shots.push({ name, data:(await screenshot()).data });
  };
  await command("Emulation.setDeviceMetricsOverride", { width:1280, height:820, deviceScaleFactor:1, mobile:false });
  await evaluate("document.querySelector('#nav-tasks').click()");
  assert.equal(await evaluate("document.querySelector('#terminal-panel').hidden"), true, "终端默认应隐藏");
  await evaluate("document.querySelector('#terminal-toggle').click()");
  await check(() => evaluate(`/PS [^\\n]*>/.test(${rows})`), "终端没有出现 PowerShell 提示符");
  const opened = await evaluate(`(() => {
    const panel=document.querySelector('#terminal-panel'), rowsElement=panel.querySelector('.xterm-rows');
    const span=rowsElement.querySelector('span');
    return { expanded:document.querySelector('#terminal-toggle').getAttribute('aria-expanded'), height:panel.getBoundingClientRect().height,
      cwd:panel.querySelector('.terminal-cwd').textContent, adopted:document.adoptedStyleSheets.length,
      color:getComputedStyle(rowsElement).color, text:getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
      spanDisplay:span ? getComputedStyle(span).display : null,
      viewportBackground:getComputedStyle(panel.querySelector('.xterm-viewport')).backgroundColor,
      panelBackground:getComputedStyle(panel).backgroundColor,
      composerVisible:document.querySelector('.composer-card').getBoundingClientRect().height > 0 };
  })()`);
  assert.equal(opened.expanded, "true");
  assert(opened.height >= 120 && opened.composerVisible, `终端面板尺寸不对：${JSON.stringify(opened)}`);
  assert(opened.cwd, `终端没有显示工作目录：${JSON.stringify(opened)}`);
  // xterm 的配色写在它自己生成的 <style> 里；CSP 拦掉后由构造样式表生效。
  assert(opened.adopted > 0, `xterm 的样式没有通过构造样式表生效：${JSON.stringify(opened)}`);
  const hex = opened.text.replace("#", "");
  const expected = `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`;
  assert.equal(opened.color, expected, "终端文字没有使用主题颜色");
  assert.equal(opened.viewportBackground, opened.panelBackground, "终端底层视口没有使用主题背景（底部会露出黑边）");
  await typeLine(command, evaluate, "Write-Output (\"bitagent-\" + (6*7)); (Get-Location).Path");
  // 输出行是 bitagent-42，下一行是 Get-Location 的结果。ConPTY 会整屏重绘，所以等它稳定。
  let lines = [];
  const outputThenCwd = async () => {
    lines = await evaluate(lineList);
    const index = lines.findLastIndex(line => line === "bitagent-42");
    return index >= 0 && lines[index + 1] === opened.cwd;
  };
  try {
    await check(outputThenCwd, "终端命令没有输出结果");
  } catch (error) {
    throw new Error(`终端输出或工作目录不对：${JSON.stringify({ cwd:opened.cwd, lines:lines.filter(Boolean) })}`, { cause:error });
  }
  for (const theme of ["light", "dark"]) {
    await evaluate(`if(document.documentElement.dataset.theme!==${JSON.stringify(theme)})document.querySelector('#theme-toggle').click()`);
    await check(() => evaluate(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`), "主题切换没有生效");
    await capture(`terminal-${theme}-1280.png`);
  }
  await evaluate("document.querySelector('#theme-toggle').click()");
  await evaluate("document.querySelector('#terminal-panel [data-action=hide]').click()");
  assert.equal(await evaluate("document.querySelector('#terminal-panel').hidden"), true, "隐藏按钮没有收起终端");
  await evaluate("document.querySelector('#terminal-toggle').click()");
  assert(await evaluate(`${rows}.includes('bitagent-42')`), "重新打开后终端内容丢失（应保留原会话）");
  await evaluate("document.querySelector('#terminal-panel [data-action=restart]').click()");
  try {
    await check(() => evaluate(`!${rows}.includes('bitagent-42') && /PS [^\\n]*>/.test(${rows})`), "重新启动没有开启新的会话");
  } catch (error) {
    const screen = await evaluate(`${lineList}.filter(Boolean)`);
    throw new Error(`重新启动没有开启新的会话：${JSON.stringify(screen)}`, { cause:error });
  }

  // 焦点在终端里按 Ctrl+= / Ctrl+0：缩放整个应用界面（终端跟着放大），按键不进 Shell。
  const zoom = () => main(`process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app/package.json')('electron')
    .BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()`);
  const before = await evaluate(rows);
  await evaluate(`document.querySelector('${current} .xterm-helper-textarea').focus()`);
  await key(command, { key:"=", code:"Equal", windowsVirtualKeyCode:187, modifiers:2 });
  await check(async () => Math.abs(await zoom() - 1.1) < 0.001, "Ctrl+= 没有放大应用界面");
  await key(command, { key:"0", code:"Digit0", windowsVirtualKeyCode:48, modifiers:2 });
  await check(async () => Math.abs(await zoom() - 1) < 0.001, "Ctrl+0 没有恢复应用界面大小");
  assert.equal(await evaluate(rows), before, "缩放快捷键被当成按键发给了 Shell");

  // 查找：同一行出现两次的词，计数显示“第几个/共几个”。
  await typeLine(command, evaluate, "Write-Output 'needle-one needle-one'");
  await check(() => evaluate(`${rows}.includes('needle-one needle-one')`), "查找用的输出没有出现");
  await evaluate("document.querySelector('#terminal-panel [data-action=find]').click()");
  await evaluate(`(() => { const input=document.querySelector('#terminal-panel .terminal-find input'); input.value='needle-one'; input.dispatchEvent(new Event('input')); })()`);
  // 输入命令那一行也含这个词，所以是 4 处（命令里 2 处、输出里 2 处）。
  await check(() => evaluate("/^\\d+\\/4$/.test(document.querySelector('#terminal-panel .terminal-find-count').textContent)"),
    "终端查找没有给出结果计数");
  await evaluate("document.querySelector('#terminal-panel .terminal-find input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert.equal(await evaluate("document.querySelector('#terminal-panel .terminal-find').hidden"), true, "Esc 没有关闭终端查找");

  // 引用到对话：没有选中时取最后几十行，作为代码块放进输入框。
  await evaluate("document.querySelector('#terminal-panel [data-action=quote]').click()");
  const quoted = await evaluate("document.querySelector('#objective').value");
  assert(quoted.includes("```") && quoted.includes("needle-one needle-one"), `引用到对话的内容不对：${JSON.stringify(quoted.slice(0, 300))}`);
  await evaluate("(() => { const input=document.querySelector('#objective'); input.value=''; input.dispatchEvent(new Event('input',{bubbles:true})); })()");

  // 输出里的网址：Ctrl+点击在内置浏览器的新标签页打开。
  const linkUrl = "http://127.0.0.1:9/terminal-link";
  await typeLine(command, evaluate, `Write-Output '${linkUrl}'`);
  await check(() => evaluate(`${lineList}.includes(${JSON.stringify(linkUrl)})`), "网址没有输出到终端");
  // 用 Range 取网址里第 10 个字符在屏幕上的位置（输出那一行，不是命令那一行）。
  const point = await evaluate(`(() => {
    const row=[...document.querySelectorAll('${current} .xterm-rows > div')].filter(element=>element.textContent.trim()===${JSON.stringify(linkUrl)}).at(-1);
    const walker=document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let offset=row.textContent.indexOf('http')+10;
    for (let node=walker.nextNode(); node; node=walker.nextNode()) {
      if (offset < node.textContent.length) { const range=document.createRange(); range.setStart(node, offset); range.setEnd(node, offset+1);
        const rect=range.getBoundingClientRect(); return { x:Math.round(rect.left+rect.width/2), y:Math.round(rect.top+rect.height/2) }; }
      offset -= node.textContent.length;
    }
    return null; })()`);
  assert(point, "没有找到终端里网址的位置");
  await command("Input.dispatchMouseEvent", { type:"mouseMoved", x:point.x, y:point.y, modifiers:2 });
  await new Promise(resolve => setTimeout(resolve, 200));
  await command("Input.dispatchMouseEvent", { type:"mousePressed", x:point.x, y:point.y, button:"left", clickCount:1, modifiers:2 });
  await command("Input.dispatchMouseEvent", { type:"mouseReleased", x:point.x, y:point.y, button:"left", clickCount:1, modifiers:2 });
  await check(() => evaluate(`document.querySelector('.shell').dataset.browserOpen==='true'
    && [...document.querySelectorAll('#browser-pane .browser-tab')].some(tab=>tab.title.includes(${JSON.stringify(linkUrl)}))`),
  "Ctrl+点击终端里的网址没有在内置浏览器打开");
  // 收拾：关掉这个标签页和浏览器，后面的浏览器验收从空白开始。
  await evaluate("document.querySelectorAll('#browser-pane .browser-tab .browser-tab-close').forEach(button=>button.click())");
  await check(() => evaluate("!document.querySelector('#browser-pane .browser-tab')"), "没有关掉终端链接打开的标签页");
  await evaluate("document.querySelector('#browser-pane [data-action=close]').click(); localStorage.removeItem('bit-agent.browser-tabs.v1')");

  // 多个终端：新建、各自独立、切换、关闭。
  await evaluate("document.querySelector('#terminal-panel [data-action=new]').click()");
  await check(() => evaluate(`document.querySelectorAll('#terminal-panel .terminal-tab').length===2 && /PS [^\\n]*>/.test(${rows})`),
    "新建的第二个终端没有启动");
  await typeLine(command, evaluate, "Write-Output second-terminal");
  await check(() => evaluate(`${lineList}.includes('second-terminal')`), "第二个终端没有输出");
  await evaluate("document.querySelectorAll('#terminal-panel .terminal-tab')[0].click()");
  await check(() => evaluate(`${rows}.includes('needle-one') && !${rows}.includes('second-terminal')`), "切回第一个终端后显示的不是它的内容");
  await evaluate("document.querySelectorAll('#terminal-panel .terminal-tab')[1].querySelector('.terminal-tab-close').click()");
  await check(() => evaluate("document.querySelectorAll('#terminal-panel .terminal-tab').length===1"), "关闭第二个终端失败");

  // 代码仓库页：终端跟过去，放在编辑区和状态栏之间。
  await evaluate("document.querySelector('#nav-repository').click()");
  const repository = await evaluate(`(() => { const panel=document.querySelector('#terminal-panel'), view=document.querySelector('#repository-view');
    const status=view.querySelector('.editor-status').getBoundingClientRect(), box=panel.getBoundingClientRect();
    return { inside:panel.parentElement===view, visible:box.height>=120, aboveStatus:Math.abs(box.bottom-status.top)<=1 }; })()`);
  assert.deepEqual(repository, { inside:true, visible:true, aboveStatus:true }, `代码仓库页的终端位置不对：${JSON.stringify(repository)}`);
  await check(() => evaluate(`${rows}.includes('needle-one')`), "到代码仓库页后终端内容丢失");
  await evaluate("document.querySelector('#nav-tasks').click()");
  assert.equal(await evaluate("document.querySelector('#terminal-panel').parentElement.classList.contains('main-center')"), true, "回到对话页后终端没有跟回来");

  await evaluate("document.querySelector('#terminal-toggle').click()");
  assert.equal(await evaluate("document.querySelector('#terminal-panel').hidden"), true);
  return { result:{ prompt:true, commandOutput:true, cwd:opened.cwd, themedByConstructedSheets:true, keptWhenHidden:true, restart:true,
    appZoom:true, find:true, quoteToConversation:true, linkOpensBrowser:true, multipleTerminals:true, followsRepositoryView:true }, shots };
}
