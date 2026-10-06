import assert from "node:assert/strict";

const widthKey = "bit-agent.sidebar-width.v1";
const inspectorKey = "bit-agent.inspector-collapsed.v1";
const workspaceRoots = "[...document.querySelectorAll('.workspace-group')].map(group=>group.dataset.root)";
const workspaceContents = `Object.fromEntries([...document.querySelectorAll('.workspace-group')].map(group=>
  [group.dataset.root,[...group.querySelectorAll('.history-row')].map(row=>row.dataset.conversationId)]))`;

async function reloadDocument(evaluate, check, context, preparation = "") {
  const token = `${Date.now()}-${Math.random()}`;
  await evaluate(`(() => { window.__reloadProbe=${JSON.stringify(token)}; ${preparation}; location.reload(); })()`);
  await check(() => evaluate(`window.__reloadProbe!==${JSON.stringify(token)} && document.readyState==='complete'
    && Boolean(document.querySelector('#sidebar-resize') && window.bitAgent?.runtimeConfig)`),
    `${context}：没有创建并初始化新的 Document（reload probe ${token}）`);
}

async function waitWorkspaceReady(evaluate, check, context) {
  let latest;
  try {
    await check(async () => {
      latest = await evaluate(`({ roots:${workspaceRoots}, busy:document.body.dataset.busy??null,
        draggable:[...document.querySelectorAll('.workspace-group')].map(group=>
          group.querySelector('.workspace-group-header')?.draggable??null) })`);
      return latest.roots.length >= 2 && latest.busy !== "true" && latest.draggable.every(value => value === true);
    }, context);
  } catch (error) {
    throw new Error(`${context}；实际状态：${JSON.stringify(latest)}`, { cause:error });
  }
}

export async function verifyWorkspaceOrder(evaluate, check) {
  await evaluate("document.querySelector('#nav-tasks').click()");
  await waitWorkspaceReady(evaluate, check, "工作区排序验收需要至少两个已加载且可拖动的分组");
  const before = await evaluate(`({ roots:${workspaceRoots}, contents:${workspaceContents},
    known:localStorage.getItem('bit-agent.workspaces.v1') })`);
  const drag = await evaluate(`(() => {
    const groups=[...document.querySelectorAll('.workspace-group')];
    const source=groups.at(-1).querySelector('.workspace-group-header'), target=groups[0].querySelector('.workspace-group-header');
    if(!source.draggable || !target.draggable) throw new Error('工作区标题不可拖动');
    const data=new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:data}));
    const rect=target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data,clientY:rect.top+1}));
    const marker=target.dataset.workspaceDropPosition;
    target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientY:rect.top+1}));
    source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:data}));
    return { types:[...data.types], marker };
  })()`);
  assert.deepEqual(drag.types, ["application/x-bit-agent-workspace"], "工作区拖放没有使用独立类型");
  assert.equal(drag.marker, "before", "工作区拖动没有显示目标之前的插入位置");
  const expected = [before.roots.at(-1), ...before.roots.slice(0, -1)];
  assert.deepEqual(await evaluate(workspaceRoots), expected, "拖动文件夹标题没有调整工作区顺序");
  assert.deepEqual(await evaluate(workspaceContents), before.contents, "调整工作区顺序改变了内部对话顺序");
  assert.equal(await evaluate("localStorage.getItem('bit-agent.workspaces.v1')"), before.known, "侧栏排序改写了目录选择列表");
  await evaluate("[...document.querySelectorAll('.history-item')].find(item=>item.dataset.active!=='true')?.click()");
  await waitWorkspaceReady(evaluate, check, "工作区排序后无法打开对话并恢复可拖动分组");
  assert.deepEqual(await evaluate(workspaceRoots), expected, "点击对话改变了工作区顺序");
  await reloadDocument(evaluate, check, "工作区排序刷新验收");
  await check(async () => JSON.stringify(await evaluate(workspaceRoots)) === JSON.stringify(expected), "刷新后没有保留工作区顺序");
  assert.deepEqual(await evaluate(workspaceContents), before.contents, "刷新后工作区内部的对话顺序变化");
  assert.equal(await evaluate("localStorage.getItem('bit-agent.workspaces.v1')"), before.known);
  return { roots:expected, headerDrag:true, clickPreservesOrder:true, conversationsUnchanged:true,
    chooserDirectoriesUnchanged:true, persistedAfterReload:true };
}

async function sidebarGeometry(evaluate) {
  return evaluate(`(() => {
    const sidebar=document.querySelector('.sidebar-left').getBoundingClientRect();
    const shell=document.querySelector('.shell').getBoundingClientRect(), handle=document.querySelector('#sidebar-resize');
    const center=document.querySelector(document.querySelector('.shell').dataset.view==='repository'?'#repository-view':'.main-center').getBoundingClientRect();
    return { width:sidebar.width, centerWidth:center.width, viewport:innerWidth, shellLeft:shell.left, shellRight:shell.right,
      overflow:document.body.scrollWidth-innerWidth, minimum:Number(handle.getAttribute('aria-valuemin')),
      maximum:Number(handle.getAttribute('aria-valuemax')), value:Number(handle.getAttribute('aria-valuenow')),
      stored:localStorage.getItem(${JSON.stringify(widthKey)}), view:document.querySelector('.shell').dataset.view,
      inspectorWidth:document.querySelector('.sidebar-right').getBoundingClientRect().width,
      inspectorCollapsed:document.querySelector('.shell').dataset.inspectorCollapsed,
      sidebarCss:document.documentElement.style.getPropertyValue('--sidebar-width'),
      dragging:document.body.dataset.sidebarResizing==='true' };
  })()`);
}

async function waitSidebarGeometry(evaluate, check, predicate, message) {
  let latest;
  try {
    await check(async () => {
      latest = await sidebarGeometry(evaluate);
      return predicate(latest);
    }, message);
  } catch (error) {
    throw new Error(`${message}；实际几何：${JSON.stringify(latest)}`, { cause:error });
  }
  return latest;
}

async function settledSidebar(evaluate, check) {
  let previous;
  return waitSidebarGeometry(evaluate, check, geometry => {
    const snapshot = JSON.stringify(geometry);
    const stable = snapshot === previous && Math.abs(geometry.width-geometry.value) <= 1;
    previous = snapshot;
    return stable;
  }, "侧栏几何没有稳定");
}

function assertSidebarGeometry(geometry) {
  const details = `；实际几何：${JSON.stringify(geometry)}`;
  assert(geometry.width >= geometry.minimum - 1 && geometry.width <= geometry.maximum + 1, `侧栏宽度超过声明的约束${details}`);
  assert(Math.abs(geometry.width - geometry.value) <= 1, `拖动后实际侧栏宽度和可访问状态不一致${details}`);
  assert(geometry.centerWidth > 200 && geometry.shellLeft >= -1 && geometry.shellRight <= geometry.viewport + 1
    && geometry.overflow <= 1, `调整侧栏宽度挤出了主要内容或造成横向溢出${details}`);
  assert(!geometry.dragging, `鼠标释放后仍保留侧栏拖动状态${details}`);
}

async function dragSidebar(command, evaluate, check, delta) {
  const position = await evaluate(`(() => { const r=document.querySelector('#sidebar-resize').getBoundingClientRect();
    return { x:r.x+r.width/2, y:r.y+Math.min(160,r.height/2), viewport:innerWidth }; })()`);
  const targetX = Math.max(1, Math.min(position.viewport-8, position.x+delta));
  const pointer = { fromX:position.x, toX:targetX, y:position.y, requestedDelta:delta };
  await command("Input.dispatchMouseEvent", { type:"mouseMoved", x:position.x, y:position.y, buttons:0 });
  await command("Input.dispatchMouseEvent", { type:"mousePressed", x:position.x, y:position.y, button:"left", buttons:1, clickCount:1 });
  try {
    await check(() => evaluate("document.body.dataset.sidebarResizing==='true'"), `原生鼠标没有开始调整侧栏宽度；坐标：${JSON.stringify(pointer)}`);
    await command("Input.dispatchMouseEvent", { type:"mouseMoved", x:targetX, y:position.y, buttons:1 });
  } finally {
    await command("Input.dispatchMouseEvent", { type:"mouseReleased", x:targetX, y:position.y, button:"left", buttons:0, clickCount:1 });
  }
  await check(() => evaluate("document.body.dataset.sidebarResizing!=='true'"), `原生鼠标释放未结束侧栏调整；坐标：${JSON.stringify(pointer)}`);
  const geometry = { ...await settledSidebar(evaluate, check), pointer };
  assertSidebarGeometry(geometry);
  assert(Math.abs(Number(geometry.stored) - geometry.width) <= 1, `拖动后的侧栏宽度没有保存；实际几何：${JSON.stringify(geometry)}`);
  return geometry;
}

async function restoreSidebar(command, evaluate, check, before) {
  await command("Emulation.setDeviceMetricsOverride", { width:before.viewport, height:before.height,
    deviceScaleFactor:before.scale, mobile:false });
  await reloadDocument(evaluate, check, "恢复侧栏状态", `
    const restore=(key,value)=>value===null?localStorage.removeItem(key):localStorage.setItem(key,value);
    restore(${JSON.stringify(widthKey)},${JSON.stringify(before.stored)});
    restore(${JSON.stringify(inspectorKey)},${JSON.stringify(before.inspectorStored)});
  `);
  await settledSidebar(evaluate, check);
  await evaluate(`(() => {
    const root=document.documentElement;
    if(${JSON.stringify(before.inspectorCss)}) root.style.setProperty('--inspector-width',${JSON.stringify(before.inspectorCss)});
    else root.style.removeProperty('--inspector-width');
    if(document.querySelector('.shell').dataset.inspectorCollapsed!==${JSON.stringify(before.inspectorCollapsed)}) document.querySelector('#inspector-toggle').click();
    document.querySelector(${JSON.stringify(before.view === "repository" ? "#nav-repository" : "#nav-tasks")}).click();
    if(${JSON.stringify(before.inspectorStored)}===null) localStorage.removeItem(${JSON.stringify(inspectorKey)});
  })()`);
  await waitSidebarGeometry(evaluate, check, geometry => Math.abs(geometry.width-before.width) <= 1
    && Math.abs(geometry.inspectorWidth-before.inspectorWidth) <= 1
    && geometry.view===before.view && geometry.inspectorCollapsed===before.inspectorCollapsed,
  `验收没有恢复原布局；起始状态：${JSON.stringify(before)}`);
  assert.equal(await evaluate("document.querySelector('.shell').dataset.inspectorCollapsed"), before.inspectorCollapsed);
  assert.equal(await evaluate("localStorage.getItem('bit-agent.sidebar-width.v1')"), before.stored);
  assert.equal(await evaluate("innerWidth"), before.viewport, "验收没有恢复起始窗口宽度");
  assert.equal(await evaluate("innerHeight"), before.height, "验收没有恢复起始窗口高度");
}

export async function verifySidebarResize(command, evaluate, check) {
  await settledSidebar(evaluate, check);
  const before = await evaluate(`({ viewport:innerWidth, height:innerHeight, scale:devicePixelRatio,
    width:document.querySelector('.sidebar-left').getBoundingClientRect().width,
    stored:localStorage.getItem(${JSON.stringify(widthKey)}), inspectorStored:localStorage.getItem(${JSON.stringify(inspectorKey)}),
    inspectorCollapsed:document.querySelector('.shell').dataset.inspectorCollapsed, view:document.querySelector('.shell').dataset.view,
    inspectorWidth:document.querySelector('.sidebar-right').getBoundingClientRect().width,
    inspectorCss:document.documentElement.style.getPropertyValue('--inspector-width') })`);
  let result, failure;
  try {
    await command("Emulation.setDeviceMetricsOverride", { width:1440, height:900, deviceScaleFactor:1, mobile:false });
    await evaluate("document.querySelector('#nav-tasks').click();if(document.querySelector('.shell').dataset.inspectorCollapsed!=='true')document.querySelector('#inspector-close').click()");
    await check(() => evaluate("document.querySelector('#sidebar-resize').getClientRects().length>0"), "侧栏调整手柄没有显示");
    const initial = await settledSidebar(evaluate, check);
    const delta = initial.maximum-initial.width >= 70 ? 70 : -60;
    const chat = await dragSidebar(command, evaluate, check, delta);
    assert(Math.abs(chat.width-initial.width) >= 20, `原生鼠标拖动没有改变聊天侧栏宽度；起始：${JSON.stringify(initial)}；拖动：${JSON.stringify(chat)}`);
    await evaluate("document.querySelector('#nav-repository').click()");
    await waitSidebarGeometry(evaluate, check, geometry => geometry.view==='repository' && Math.abs(geometry.width-chat.width) <= 1,
      "代码仓库页没有沿用聊天侧栏宽度");
    const repositoryBefore = await settledSidebar(evaluate, check);
    const repository = await dragSidebar(command, evaluate, check, repositoryBefore.maximum-repositoryBefore.width+32);
    assert(Math.abs(repository.width-repository.maximum) <= 1, `极限拖动没有按当前窗口约束收住宽度；实际几何：${JSON.stringify(repository)}`);
    await evaluate("document.querySelector('#nav-tasks').click()");
    await waitSidebarGeometry(evaluate, check, geometry => geometry.view==='tasks' && Math.abs(geometry.width-repository.width) <= 1,
      "聊天页没有沿用代码仓库页调整的宽度");
    await reloadDocument(evaluate, check, "侧栏宽度刷新验收");
    const reloaded = await settledSidebar(evaluate, check);
    assertSidebarGeometry(reloaded);
    assert(Math.abs(reloaded.width-repository.width) <= 1, `刷新后没有保留拖动后的侧栏宽度；实际几何：${JSON.stringify(reloaded)}`);
    await evaluate("document.querySelector('#nav-repository').click()");
    await waitSidebarGeometry(evaluate, check, geometry => geometry.view==='repository' && Math.abs(geometry.width-repository.width) <= 1,
      "刷新后代码仓库页的侧栏宽度不一致");
    result = { nativeMouseDrag:true, sharedAcrossViews:true, persistedAfterReload:true,
      clampedToViewport:true, chatWidth:chat.width, repositoryWidth:repository.width };
  } catch (error) {
    failure = error;
  }
  try {
    await restoreSidebar(command, evaluate, check, before);
  } catch (error) {
    if (failure) throw new AggregateError([failure, error], "侧栏验收失败，且恢复原布局也失败");
    throw error;
  }
  if (failure) throw failure;
  return { ...result, originalViewportAndSidebarRestored:true };
}
