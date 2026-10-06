import assert from "node:assert/strict";

// 带括号：拼进 `${rows}.includes(...)` 和 `!${rows}` 时优先级才对。
const rows = "(document.querySelector('#terminal-panel .xterm-rows')?.textContent ?? '')";

async function typeLine(command, evaluate, text) {
  await evaluate("document.querySelector('#terminal-panel .xterm-helper-textarea').focus()");
  await command("Input.insertText", { text });
  for (const type of ["keyDown", "keyUp"]) {
    await command("Input.dispatchKeyEvent", { type, key:"Enter", code:"Enter", windowsVirtualKeyCode:13, ...(type === "keyDown" ? { text:"\r" } : {}) });
  }
}

/** 内置终端：打开、运行命令、配色生效（CSP 下的样式镜像）、隐藏后保留、重新启动。 */
export async function verifyTerminal({ command, evaluate, check, screenshot }) {
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
    lines = await evaluate(`[...document.querySelectorAll('#terminal-panel .xterm-rows > div')].map(row=>row.textContent.trim())`);
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
    const screen = await evaluate(`[...document.querySelectorAll('#terminal-panel .xterm-rows > div')].map(row=>row.textContent.trim()).filter(Boolean)`);
    throw new Error(`重新启动没有开启新的会话：${JSON.stringify(screen)}`, { cause:error });
  }
  await evaluate("document.querySelector('#terminal-toggle').click()");
  assert.equal(await evaluate("document.querySelector('#terminal-panel').hidden"), true);
  return { result:{ prompt:true, commandOutput:true, cwd:opened.cwd, themedByConstructedSheets:true, keptWhenHidden:true, restart:true }, shots };
}
