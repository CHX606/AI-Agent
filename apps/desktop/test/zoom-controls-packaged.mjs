import assert from "node:assert/strict";
import { setTerminalPosition } from "./terminal-packaged.mjs";

const panel = "document.querySelector('.zoom-controls')";
const electron = "process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app/package.json')('electron')";
const windowExpression = `${electron}.BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('index.html'))`;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const keys = {
  in: { key:"=", code:"Equal", windowsVirtualKeyCode:187, modifiers:2 },
  plus: { key:"+", code:"Equal", windowsVirtualKeyCode:187, modifiers:10 },
  out: { key:"-", code:"Minus", windowsVirtualKeyCode:189, modifiers:2 },
  reset: { key:"0", code:"Digit0", windowsVirtualKeyCode:48, modifiers:2 },
  add: { key:"+", code:"NumpadAdd", windowsVirtualKeyCode:107, modifiers:2, isKeypad:true },
  subtract: { key:"-", code:"NumpadSubtract", windowsVirtualKeyCode:109, modifiers:2, isKeypad:true },
};

async function key(command, name) {
  for (const type of ["keyDown", "keyUp"]) await command("Input.dispatchKeyEvent", { type, ...keys[name] });
}

const readUi = evaluate => evaluate(`(() => {
  const control=${panel};
  return { hidden:control.hidden, open:control.matches(':popover-open'), count:document.querySelectorAll('.zoom-controls').length,
    percentage:control.querySelector('.zoom-level').textContent.trim(),
    actions:[...control.querySelectorAll('button')].map(button=>button.dataset.zoomAction),
    reset:control.querySelector('[data-zoom-action=reset]').textContent.trim() };
})()`);

async function expectZoom(context, factor, message) {
  const { evaluate, check, main } = context;
  let observed;
  await check(async () => {
    const actual = await main(`${windowExpression}.webContents.getZoomFactor()`);
    const ui = await readUi(evaluate);
    observed = { actual, ...ui };
    return Math.abs(actual-factor) < 0.001 && !ui.hidden && ui.open
      && ui.percentage === `${Math.round(actual*100)}%`;
  }, message);
  await waitRenderedScale(context, factor);
  assert.equal(observed.count, 1, "重复创建了缩放浮条");
  assert.deepEqual(observed.actions, ["out", "in", "reset"], "缩放浮条按钮次序或数量不对");
  assert.equal(observed.reset, "重置", "缩放浮条缺少重置按钮");
  return observed;
}

async function focusObjective(evaluate) {
  await evaluate("document.querySelector('#objective').focus()");
}

async function expectObjectiveFocus(evaluate) {
  assert(await evaluate("document.activeElement===document.querySelector('#objective')"), "缩放浮条抢走了输入框焦点");
}

async function verifyShortcuts(context) {
  const { command, evaluate } = context;
  const before = await evaluate("document.querySelector('#objective').value");
  const results = [];
  await focusObjective(evaluate);
  for (const [name, factor] of [["reset",1], ["in",1.1], ["plus",1.25], ["out",1.1], ["reset",1],
    ["out",0.9], ["add",1], ["add",1.1], ["subtract",1], ["reset",1]]) {
    await key(command, name);
    const observed = await expectZoom(context, factor, `${name} 快捷键没有显示真实应用缩放比例 ${factor*100}%`);
    await expectObjectiveFocus(evaluate);
    results.push({ shortcut:name, factor:observed.actual, percentage:observed.percentage });
  }
  for (const [deltaY, factor] of [[-120,1.1], [120,1]]) {
    await pause(160);
    const point = await evaluate(`(() => { const rect=document.querySelector('#objective').getBoundingClientRect();
      return { x:rect.left+rect.width/2, y:rect.top+rect.height/2 }; })()`);
    await command("Input.dispatchMouseEvent", { type:"mouseWheel", ...point, modifiers:2, deltaX:0, deltaY });
    const observed = await expectZoom(context, factor, "Ctrl+滚轮没有显示真实应用缩放比例");
    await expectObjectiveFocus(evaluate);
    results.push({ shortcut:"ctrl-wheel", deltaY, factor:observed.actual, percentage:observed.percentage });
  }
  assert.equal(await evaluate("document.querySelector('#objective').value"), before, "缩放快捷键改变了输入框内容");
  return results;
}

async function verifyButtonsAndRapidKeys(context) {
  const { command, evaluate } = context;
  const results = [];
  for (const [action, factor] of [["in",1.1], ["out",1], ["out",0.9], ["reset",1]]) {
    await evaluate(`${panel}.querySelector('[data-zoom-action=${action}]').click()`);
    const observed = await expectZoom(context, factor, `浮条 ${action} 按钮没有改变实际应用缩放`);
    results.push({ action, factor:observed.actual, percentage:observed.percentage });
  }
  await focusObjective(evaluate);
  for (let count=0; count<3; count++) await key(command, "in");
  await expectZoom(context, 1.5, "快速连续缩放后浮条比例没有跟上实际应用比例");
  await expectObjectiveFocus(evaluate);
  await key(command, "reset");
  await expectZoom(context, 1, "连续缩放后没有恢复 100%");
  return results;
}

async function movePointer(command, evaluate, inside) {
  const point = inside ? await evaluate(`(() => { const rect=${panel}.getBoundingClientRect();
    return { x:rect.left+rect.width/2, y:rect.top+rect.height/2 }; })()`) : { x:2, y:2 };
  await command("Input.dispatchMouseEvent", { type:"mouseMoved", ...point });
}

async function expectHidden(evaluate, check) {
  await check(() => evaluate(`${panel}.hidden && !${panel}.matches(':popover-open')`), "无操作后缩放浮条没有自动隐藏");
}

async function verifyVisibility(context) {
  const { command, evaluate, check } = context;
  await focusObjective(evaluate);
  await movePointer(command, evaluate, false);
  const idleStarted = Date.now();
  await key(command, "reset");
  await expectZoom(context, 1, "自动隐藏验收没有显示浮条");
  await expectHidden(evaluate, check);
  const idleMilliseconds = Date.now()-idleStarted;
  assert(idleMilliseconds >= 2500 && idleMilliseconds <= 5000,
    `浮条没有在约 3 秒无操作后隐藏：${idleMilliseconds}ms`);

  await key(command, "reset");
  await expectZoom(context, 1, "悬停验收没有显示浮条");
  await movePointer(command, evaluate, true);
  await check(() => evaluate(`${panel}.matches(':hover')`), "真实鼠标没有进入缩放浮条");
  await pause(3500);
  await expectZoom(context, 1, "悬停期间缩放浮条提前隐藏");
  await movePointer(command, evaluate, false);
  await expectHidden(evaluate, check);

  await key(command, "reset");
  await expectZoom(context, 1, "焦点验收没有显示浮条");
  await evaluate(`${panel}.querySelector('[data-zoom-action=reset]').focus()`);
  assert(await evaluate(`${panel}.matches(':focus-within')`), "缩放按钮没有得到键盘焦点");
  await pause(3500);
  await expectZoom(context, 1, "键盘焦点在浮条内时提前隐藏");
  await focusObjective(evaluate);
  await expectHidden(evaluate, check);
  return { idleMilliseconds, hoverPauses:true, focusPauses:true, resumesAfterLeaving:true };
}

async function renderFrame({ main }) {
  await pause(200);
  await main(`${windowExpression}.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}).then(()=>true)`);
}

async function waitDeviceScale({ evaluate, check, baseDpr }, factor) {
  await check(() => evaluate(`Math.abs(devicePixelRatio-${baseDpr*factor})<0.015`),
    `缩放 ${Math.round(factor*100)}% 的真实 DPR 尚未更新至 ${baseDpr*factor}`);
}

async function waitRenderedScale(context, factor) {
  if (!(context.baseDpr > 0)) return;
  await renderFrame(context);
  await waitDeviceScale(context, factor);
}

async function inspectGeometry(context, theme, width, factor) {
  const { evaluate } = context;
  // 主进程 IPC 返回早于 Chromium 布局；必须先观察到真实缩放的 DPR，再读取任何几何。
  await waitDeviceScale(context, factor);
  const geometry = await evaluate(`(() => {
    const control=${panel}, box=control.getBoundingClientRect(), style=getComputedStyle(control);
    const titlebar=document.querySelector('.window-titlebar').getBoundingClientRect();
    const overlay=navigator.windowControlsOverlay, nativeRect=overlay?.getTitlebarAreaRect();
    const probe=document.createElement('span'); probe.hidden=true;
    probe.style.backgroundColor='var(${theme === "dark" ? "--bg-rail" : "--bg-panel"})'; probe.style.color='var(--text)';
    document.body.append(probe); const palette=getComputedStyle(probe);
    const expectedBackground=palette.backgroundColor, expectedColor=palette.color; probe.remove();
    const rectOf=element=>{const rect=element.getBoundingClientRect();return {
      left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height};};
    const visible=element=>{const rect=element.getBoundingClientRect(), css=getComputedStyle(element);
      return element.getClientRects().length && rect.width>0 && rect.height>0 && css.visibility!=='hidden'
        && rect.bottom>0 && rect.top<innerHeight && rect.right>0 && rect.left<innerWidth;};
    const shell=document.querySelector('.shell');
    const selectors='.task-header,.right-header,.browser-toolbar,.editor-tabs,.editor-breadcrumbs,.terminal-header';
    const toolbars=[...document.querySelectorAll(selectors)].filter(visible).map(element=>({name:element.className,...rectOf(element)}));
    const parts=[...control.querySelectorAll('.zoom-level, button, .zoom-divider')].map(element=>({
      name:element.className || element.dataset.zoomAction,...rectOf(element)}));
    return { box:rectOf(control), viewport:{ width:innerWidth,height:innerHeight },dpr:devicePixelRatio,
      titlebarBottom:titlebar.bottom,wco:{visible:Boolean(overlay?.visible),bottom:nativeRect?.bottom ?? 0,height:nativeRect?.height ?? 0},
      shell:{top:shell.getBoundingClientRect().top,borderTopWidth:parseFloat(getComputedStyle(shell).borderTopWidth),dataset:{...shell.dataset}},
      parts,toolbars,overflow:control.scrollWidth-control.clientWidth,background:style.backgroundColor,color:style.color,
      expectedBackground,expectedColor,theme:document.documentElement.dataset.theme,
      hit:document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)?.closest('.zoom-controls')===control };
  })()`);
  const label = `${theme}/${width}/${Math.round(factor*100)}%`, { box, viewport, parts, toolbars, wco } = geometry;
  assert(geometry.theme === theme && geometry.background === geometry.expectedBackground
    && geometry.color === geometry.expectedColor, `浮条没有使用当前主题颜色：${label} ${JSON.stringify(geometry)}`);
  if (wco.visible) {
    assert(geometry.titlebarBottom >= wco.bottom-0.1,
      `HTML 标题栏低于原生窗口按钮区域：${label} ${JSON.stringify(geometry)}`);
    assert(geometry.shell.top >= wco.bottom-0.1,
      `应用主体进入原生窗口按钮区域：${label} ${JSON.stringify(geometry)}`);
  }
  assert(geometry.shell.borderTopWidth > 0, `标题栏和主体之间的横线消失：${label} ${JSON.stringify(geometry)}`);
  assert(Math.abs(viewport.width*factor-width) <= factor+1,
    `验收没有使用真实窗口内容宽度：${label} ${JSON.stringify(geometry)}`);
  assert(box.width > 0 && box.height > 0 && box.left >= 8 && box.right <= viewport.width-8
    && box.top >= geometry.titlebarBottom+1 && box.bottom <= viewport.height-8 && geometry.overflow <= 1,
    `缩放浮条越界、进入标题栏或内容溢出：${label} ${JSON.stringify(geometry)}`);
  assert.equal(parts.length, 5, `百分比、三个按钮、分隔线没有完整显示：${label}`);
  for (const [index, part] of parts.entries()) {
    assert(part.width > 0 && part.height > 0 && part.left >= box.left && part.right <= box.right
      && part.top >= box.top && part.bottom <= box.bottom, `浮条控件被裁切：${label} ${JSON.stringify(part)}`);
    if (index) assert(parts[index-1].right <= part.left+1, `浮条控件互相重叠：${label}`);
  }
  for (const toolbar of toolbars) {
    const overlapX=Math.max(0,Math.min(box.right,toolbar.right)-Math.max(box.left,toolbar.left));
    const overlapY=Math.max(0,Math.min(box.bottom,toolbar.bottom)-Math.max(box.top,toolbar.top));
    if (overlapX > 0.1) assert(overlapY <= 0.1,
      `缩放浮条压住顶部工具栏：${label} ${JSON.stringify({box,toolbar,overlapX,overlapY})}`);
  }
  assert(geometry.hit, `浮条没有处在可交互的顶层：${label}`);
  return { theme, width, factor, baseDpr:context.baseDpr, ...geometry };
}

async function resizeWindow(context, width, height) {
  await context.main(`${windowExpression}.setContentSize(${width},${height},false)`);
  let actual;
  try {
    await context.check(async () => {
      actual=await context.main(`${windowExpression}.getContentSize()`);
      return Math.abs(actual[0]-width)<=1 && Math.abs(actual[1]-height)<=1;
    }, `真实窗口内容尺寸没有更新至 ${width}×${height}`);
  } catch (error) {
    throw new Error(`真实窗口内容尺寸超出 1 DIP 取整误差：${JSON.stringify({requested:[width,height],actual})}`, {cause:error});
  }
  await renderFrame(context);
}

async function verifyLayouts(context, capture, shots) {
  const { command, evaluate, check } = context;
  const results = [];
  const factors=[0.5,0.67,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2];
  for (const theme of ["light", "dark"]) {
    await evaluate(`if(document.documentElement.dataset.theme!==${JSON.stringify(theme)})document.querySelector('#theme-toggle').click()`);
    await check(() => evaluate(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`), "缩放验收主题没有切换");
    for (const width of [1280, 920]) {
      await resizeWindow(context,width,width===920 ? 680 : 820);
      await focusObjective(evaluate);
      await key(command,"reset");
      await expectZoom(context,1,"布局验收起始缩放没有恢复 100%");
      for (let count=0; count<5; count++) await key(command,"out");
      for (const [index,factor] of factors.entries()) {
        if (index) await key(command,"in");
        await expectZoom(context,factor,`实际 ${Math.round(factor*100)}% 档位没有显示正确比例`);
        // 截图及多次主进程检查期间保持按钮焦点，避免采到自动隐藏后的画面。
        await evaluate(`${panel}.querySelector('[data-zoom-action=reset]').focus()`);
        results.push(await inspectGeometry(context,theme,width,factor));
        if ([0.8,0.9,1.1].includes(factor)) {
          const name=`zoom-controls-${theme}-${width}-${Math.round(factor*100)}.png`;
          await capture(name); shots.push(name);
        }
      }
      await key(command,"reset");
      await expectZoom(context,1,"布局验收后没有恢复 100%");
    }
  }
  assert.equal(results.length,44,"真实窗口缩放几何没有覆盖两主题、两宽度和全部 11 个档位");
  return results;
}

const terminalPositionKey = "bit-agent.terminal-position.v1";

async function snapshotTerminalPosition(evaluate) {
  return evaluate(`(() => { const saved=localStorage.getItem(${JSON.stringify(terminalPositionKey)});
    return {saved,position:document.querySelector('#terminal-panel').dataset.position ?? (saved==='bottom' ? 'bottom' : 'right')}; })()`);
}

async function closeTools({ evaluate, check }) {
  await evaluate(`(() => {
    const terminal=document.querySelector('#terminal-panel'), browser=document.querySelector('#browser-pane');
    if (!terminal.hidden) terminal.querySelector('[data-action=hide]').click();
    if (!browser.hidden) browser.querySelector('[data-action=close]').click();
  })()`);
  await check(() => evaluate("document.querySelector('#terminal-panel').hidden && document.querySelector('#browser-pane').hidden"),
    "缩放组合验收没有关闭测试工具面板");
}

async function restoreTerminalPosition(context, original) {
  await closeTools(context);
  await setTerminalPosition(context.evaluate,context.check,original.position);
  await context.evaluate(`(() => {
    const key=${JSON.stringify(terminalPositionKey)}, saved=${JSON.stringify(original.saved)};
    if (saved===null) localStorage.removeItem(key); else localStorage.setItem(key,saved);
    window.dispatchEvent(new Event('bit-agent:terminal-position'));
  })()`);
  await context.check(() => context.evaluate(`document.querySelector('#terminal-panel').dataset.position===${JSON.stringify(original.position)}
    && localStorage.getItem(${JSON.stringify(terminalPositionKey)})===${JSON.stringify(original.saved)}`),
    "缩放组合验收没有恢复原终端停靠偏好");
}

async function openToolCombination(context, mode) {
  const { command, evaluate, check } = context;
  await focusObjective(evaluate);
  await key(command,"reset");
  await expectZoom(context,1,"工具面板组合切换前没有恢复 100%");
  await closeTools(context);
  const position=mode==='browser-terminal-bottom' ? 'bottom' : 'right';
  await setTerminalPosition(evaluate,check,position);
  if (mode==='terminal-first') {
    // 首次使用前这些属性不存在；关闭的工具面板使该初始布局可以安全重现。
    await evaluate("document.querySelector('.shell').removeAttribute('data-browser-open'); document.querySelector('.shell').removeAttribute('data-terminal-open')");
    assert(await evaluate("!document.querySelector('.shell').hasAttribute('data-browser-open') && !document.querySelector('.shell').hasAttribute('data-terminal-open')"),
      "没有重现首次终端使用前的未设置属性状态");
  }
  await evaluate("document.querySelector('#terminal-toggle').click()");
  if (mode!=='terminal-first') await evaluate("document.querySelector('#browser-toggle').click()");
  await check(() => evaluate(`!document.querySelector('#terminal-panel').hidden
    && document.querySelector('#terminal-panel').dataset.position===${JSON.stringify(position)}
    && document.querySelector('#browser-pane').hidden===${mode==='terminal-first'}`), "工具面板组合没有打开或停靠位置不对");
  await check(() => evaluate("Boolean(document.querySelector('.terminal-session:not([hidden]) .xterm-rows'))"),
    "终端组合没有创建实际终端会话");
  await renderFrame(context);
  if (mode==='terminal-first') assert(await evaluate("!document.querySelector('.shell').hasAttribute('data-browser-open')"),
    "首次只打开终端时浏览器属性应保持未设置");
}

async function zoomToToolFactor(context, factor) {
  await focusObjective(context.evaluate);
  await key(context.command,"reset");
  const action=factor>1 ? 'in' : 'out', count=factor===2 ? 5 : factor===0.8 ? 2 : 1;
  for (let index=0; index<count; index++) await key(context.command,action);
  await expectZoom(context,factor,`工具面板组合没有应用实际 ${Math.round(factor*100)}% 缩放`);
  await context.evaluate(`${panel}.querySelector('[data-zoom-action=reset]').focus()`);
}

async function verifyToolLayouts(context, capture, shots) {
  const results=[];
  await resizeWindow(context,920,640);
  for (const theme of ['light','dark']) {
    await context.evaluate(`if(document.documentElement.dataset.theme!==${JSON.stringify(theme)})document.querySelector('#theme-toggle').click()`);
    await context.check(() => context.evaluate(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`), "工具面板组合主题没有切换");
    for (const mode of ['terminal-first','browser-terminal-right','browser-terminal-bottom']) {
      await openToolCombination(context,mode);
      for (const factor of [0.8,0.9,2]) {
        await zoomToToolFactor(context,factor);
        const geometry=await inspectGeometry(context,theme,920,factor);
        assert(geometry.toolbars.some(toolbar=>toolbar.name.split(' ').includes('terminal-header')),
          `工具面板组合缺少可见终端标题栏：${theme}/${mode}/${factor}`);
        if (mode!=='terminal-first') assert(geometry.toolbars.some(toolbar=>toolbar.name.split(' ').includes('browser-toolbar')),
          `工具面板组合缺少可见浏览器工具栏：${theme}/${mode}/${factor}`);
        const name=`zoom-controls-tools-${mode}-${theme}-920x640-${Math.round(factor*100)}.png`;
        await capture(name); shots.push(name);
        results.push({mode,requestedSize:[920,640],...geometry});
      }
    }
  }
  assert.equal(results.length,18,"没有覆盖两主题、三个工具面板组合和 80%/90%/200% 缩放");
  await key(context.command,"reset");
  await expectZoom(context,1,"工具面板组合验收后没有恢复 100%");
  await closeTools(context);
  return results;
}

/** 真实整窗缩放反馈；内置网页缩放继续由独立浏览器验收负责。capture(name) 保存真实截图。 */
export async function verifyZoomControls({ command, evaluate, check, main, capture }) {
  const context = { command, evaluate, check, main, baseDpr:0 }, shots = [];
  const originalTheme = await evaluate("document.documentElement.dataset.theme");
  const originalSize = await main(`${windowExpression}.getContentSize()`);
  const originalTerminal = await snapshotTerminalPosition(evaluate);
  await command("Emulation.clearDeviceMetricsOverride",{});
  await main(`${windowExpression}.webContents.setBackgroundThrottling(false)`);
  try {
    await resizeWindow(context,1280,820);
    await evaluate("document.querySelector('#nav-tasks').click()");
    await check(() => evaluate(`Boolean(${panel} && document.querySelector('#objective')?.getClientRects().length
      && !document.querySelector('#objective').disabled)`), "缩放控件或可输入的任务输入框没有就绪");
    await evaluate("window.bitAgent.setZoom('reset')");
    await renderFrame(context);
    context.baseDpr = await evaluate("devicePixelRatio");
    assert(context.baseDpr > 0,"100% 下的真实设备 DPR 无效");
    await waitDeviceScale(context,1);
    const shortcuts = await verifyShortcuts(context);
    const buttons = await verifyButtonsAndRapidKeys(context);
    const visibility = await verifyVisibility(context);
    const layouts = await verifyLayouts(context, capture, shots);
    const toolLayouts = await verifyToolLayouts(context, capture, shots);
    await focusObjective(evaluate);
    await movePointer(command, evaluate, false);
    await expectHidden(evaluate, check);
    return { results:{ baseDpr:context.baseDpr,shortcuts,buttons,rapidKeys:true,objectiveFocusPreserved:true,visibility,layouts,toolLayouts }, shots };
  } finally {
    await evaluate("window.bitAgent.setZoom('reset')");
    await renderFrame(context);
    await waitDeviceScale(context,1);
    await restoreTerminalPosition(context,originalTerminal);
    await resizeWindow(context,originalSize[0],originalSize[1]);
    await evaluate(`if(document.documentElement.dataset.theme!==${JSON.stringify(originalTheme)})document.querySelector('#theme-toggle').click()`);
    await focusObjective(evaluate);
  }
}
