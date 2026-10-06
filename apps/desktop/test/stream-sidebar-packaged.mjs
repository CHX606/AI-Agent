import assert from "node:assert/strict";

const patchGroup = "document.querySelector('#current-turn .stream-tool[data-tool=apply_patch]')?.closest('.stream-group')";

export async function verifyFoldedPatch(evaluate, check) {
  await check(() => evaluate(`Boolean(${patchGroup}?.querySelector('.tool-diff')?.textContent.includes('package fixture'))`),
    "文件修改的折叠内容没有载入真实差异");
  assert(await evaluate(`(() => { const g=${patchGroup}; return g.querySelector('.group-list').hidden
    && g.querySelector('.group-head').getAttribute('aria-expanded')==='false'
    && g.querySelector('.group-summary').textContent==='修改了 1 个文件'
    && g.querySelector('.group-head').textContent.includes('+1 −0')
    && g.querySelector('.tool-diff').getClientRects().length===0; })()`), "修改操作没有默认折叠或丢失了结果摘要");
  await evaluate(`${patchGroup}.querySelector('.group-head').click()`);
  assert(await evaluate(`(() => { const g=${patchGroup}; return !g.querySelector('.group-list').hidden
    && g.querySelector('.tool-diff').getClientRects().length>0; })()`), "展开修改操作后没有显示差异");
  await evaluate(`${patchGroup}.querySelector('.group-head').click()`);
  assert(await evaluate(`${patchGroup}.querySelector('.tool-diff').getClientRects().length===0`), "再次收起仍显示文件差异");
}

export async function verifyNoEmptyText(evaluate) {
  assert(await evaluate("[...document.querySelectorAll('#current-turn .stream-text')].every(row => row.querySelector('.markdown-body')?.textContent.trim())"),
    "对话流仍存在只有圆点的空文字行");
}

export async function verifyConversationLayout(evaluate, required = {}) {
  const geometry = await evaluate(`(() => {
    const visible = selector => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length);
    const users = visible('.turn-user,.stream-user,.turn-update');
    const agents = visible('.turn > .stream > .stream-text,.turn > .stream > .stream-group');
    const probe = document.createElement('span');
    probe.hidden = true; probe.style.backgroundColor = 'var(--bg-panel)'; document.body.append(probe);
    const panelColor = getComputedStyle(probe).backgroundColor; probe.remove();
    const inspect = (element, side) => {
      const rect = element.getBoundingClientRect(), turn = element.closest('.turn').getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.left < turn.left - 1 || rect.right > turn.right + 1 || element.scrollWidth > element.clientWidth + 1)
        throw new Error('消息横向越界：' + element.className);
      if (side === 'right' && Math.abs(rect.right - turn.right) > 2)
        throw new Error('用户消息没有靠右：' + element.className);
      if (side === 'left' && Math.abs(rect.left - turn.left) > 2)
        throw new Error('Agent 回复或工具没有靠左：' + element.className);
      if (side === 'right' && style.backgroundColor !== panelColor)
        throw new Error('用户消息背景没有沿用当前主题面板色：' + style.backgroundColor + ' / ' + panelColor);
      if (side === 'right' && element.textContent.length < 80 && !element.textContent.includes('\\n') && rect.width >= turn.width * 0.78 - 1)
        throw new Error('短用户消息没有随内容收紧宽度：' + element.className);
      return { className:element.className, width:rect.width, turnWidth:turn.width, overflow:element.scrollWidth-element.clientWidth };
    };
    return { users:users.map(element => inspect(element, 'right')), agents:agents.map(element => inspect(element, 'left')),
      panelColor, current:Boolean(document.querySelector('#current-turn .turn-user')?.getClientRects().length),
      historical:visible('.saved-turn .turn-user').length, supplement:visible('#current-turn .stream-user').length,
      historicalUpdates:visible('.saved-turn .turn-update').length,
      multiline:users.some(element => element.textContent.includes('\\n')),
      longMessage:users.some(element => element.textContent.length > 300) };
  })()`);
  assert(geometry.current && geometry.users.length && geometry.agents.length, "左右对话验收缺少当前用户或 Agent 消息");
  if (required.history) assert(geometry.historical > 0, "左右对话验收缺少历史用户消息");
  if (required.supplement) assert(geometry.supplement > 0, "左右对话验收缺少运行中补充消息");
  if (required.update) assert(geometry.historicalUpdates > 0, "左右对话验收缺少历史补充要求");
  if (required.longText) assert(geometry.multiline && geometry.longMessage, "左右对话验收缺少长句或多行消息");
  return geometry;
}

export async function verifySidebarOrder(evaluate, check) {
  const before = await evaluate(`(() => {
    const groups=[...document.querySelectorAll('.workspace-group')];
    const group=groups.find(g=>g.querySelectorAll('.history-item').length>=2);
    if(!group) throw new Error('排序验收需要同一工作区至少两段对话');
    return { roots:groups.map(g=>g.dataset.root), root:group.dataset.root,
      titles:[...group.querySelectorAll('.history-item')].map(b=>b.title) };
  })()`);
  const group = `[...document.querySelectorAll('.workspace-group')].find(g=>g.dataset.root===${JSON.stringify(before.root)})`;
  const titles = `[...${group}.querySelectorAll('.history-item')].map(b=>b.title)`;
  const selected = before.titles.at(-1);
  await evaluate(`[...${group}.querySelectorAll('.history-item')].find(b=>b.title===${JSON.stringify(selected)}).click()`);
  await check(() => evaluate(`document.body.dataset.busy==='false' && [...${group}.querySelectorAll('.history-item')].some(b=>b.title===${JSON.stringify(selected)} && b.dataset.active==='true')`),
    "打开排序验收会话失败");
  assert.deepEqual(await evaluate(titles), before.titles, "点击会话改变了会话顺序");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.workspace-group')].map(g=>g.dataset.root)"), before.roots,
    "点击会话改变了工作区顺序");
  await evaluate(`(() => {
    const rows=[...${group}.querySelectorAll('.history-row')]; const source=rows.at(-1), target=rows[0];
    if(!source.draggable) throw new Error('会话行不可拖动');
    const transfer=new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));
    const rect=target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer,clientY:rect.top+1}));
    target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientY:rect.top+1}));
    source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:transfer}));
  })()`);
  const expected = [selected, ...before.titles.slice(0, -1)];
  assert.deepEqual(await evaluate(titles), expected, "拖动没有改变会话位置");
  await evaluate("location.reload()");
  await check(async () => JSON.stringify(await evaluate(`(() => { const g=${group}; return g ? [...g.querySelectorAll('.history-item')].map(b=>b.title) : []; })()`))===JSON.stringify(expected),
    "重载后没有保留手动会话顺序");
  return { workspace:before.root, clickPreservesOrder:true, dragOrder:expected, persistedAfterReload:true };
}
