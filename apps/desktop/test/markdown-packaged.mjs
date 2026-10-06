import assert from "node:assert/strict";

export function markdownFixture(imageUrl) {
  return [
    "PACKAGED_STREAM_START ", "", "## 根目录内容", "",
    "| 文件/文件夹 | 用途 |", "| :--- | ---: |", "| `index.html` | 模板总览 |", "| `README.md` | 项目说明 |", "",
    "### 常用格式", "", "**加粗**、*斜体*、~~删除线~~、`行内代码`。", "",
    "1. 第一项", "   - 嵌套项目", "2. 第二项", "",
    "- [x] 已完成", "- [ ] 待完成", "", "> 引用说明", ">", "> 支持引用里的 **加粗**。", "", "---", "",
    "[文档链接](https://example.com/docs)", "", `![验收图片](${imageUrl})`, "",
    "```python", "def hello(name):", "    return f'hi {name}'", "```", "",
    "```diff", "@@ -1 +1 @@", "-old", "+new", "```", "",
    `<img src="${imageUrl}" onerror="window.__markdownUnsafe=true">`,
    "<script>window.__markdownUnsafe=true</script>", "", "PACKAGED_STREAM_END",
  ].join("\n");
}

const clipboardModule = "process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app/package.json')('electron').clipboard";

async function clickCenter(command, evaluate, selector) {
  // 对话区是平滑滚动；立即滚到位并等一帧再取坐标，否则会点到滚动途中的位置。
  const point = await evaluate(`(async () => { const element=document.querySelector(${JSON.stringify(selector)});
    element.scrollIntoView({block:'center', behavior:'instant'});
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect=element.getBoundingClientRect(), x=Math.round(rect.left+rect.width/2), y=Math.round(rect.top+rect.height/2);
    return {x, y, hit:element.contains(document.elementFromPoint(x, y))}; })()`);
  assert(point.hit, `${selector} 被其他元素挡住，无法点击`);
  await command("Input.dispatchMouseEvent", { type:"mouseMoved", x:point.x, y:point.y });
  await command("Input.dispatchMouseEvent", { type:"mousePressed", x:point.x, y:point.y, button:"left", buttons:1, clickCount:1 });
  await command("Input.dispatchMouseEvent", { type:"mouseReleased", x:point.x, y:point.y, button:"left", buttons:0, clickCount:1 });
}

/** 真实点击代码块和回答的复制按钮，再从系统剪贴板读回；结束后恢复原剪贴板文字。 */
export async function verifyCopy({ command, evaluate, check, main }) {
  const saved = await main(`${clipboardModule}.readText()`);
  try {
    const code = "#current-turn .code-block:has(.tok-keyword)";
    const expectedCode = await evaluate(`document.querySelector(${JSON.stringify(code + " code")}).textContent`);
    const layout = await evaluate(`(() => { const block=document.querySelector(${JSON.stringify(code)});
      const box=element=>element.getBoundingClientRect(), button=box(block.querySelector('.code-copy')),
        header=box(block.querySelector('.code-header')), pre=box(block.querySelector('pre'));
      return { insideHeader:button.top>=header.top && button.bottom<=header.bottom-1 && button.right<=header.right,
        clearOfCode:button.bottom<=pre.top }; })()`);
    assert.deepEqual(layout, { insideHeader:true, clearOfCode:true }, "代码块复制按钮和边框或代码重叠");
    await main(`${clipboardModule}.writeText('')`);
    await clickCenter(command, evaluate, `${code} .code-copy`);
    // Windows 剪贴板把换行存成 \r\n。
    const pasted = async () => (await main(`${clipboardModule}.readText()`)).replace(/\r\n/gu, "\n");
    await check(async () => await pasted() === expectedCode, "代码块复制按钮没有复制代码原文").catch(async error => {
      const state = await evaluate(`document.querySelector(${JSON.stringify(code + " .code-copy")})?.dataset.state ?? "无状态"`);
      throw new Error(`${error.message}；按钮状态：${state}；剪贴板：${JSON.stringify(await pasted())}；期望：${JSON.stringify(expectedCode)}`);
    });
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(code + " .code-copy")}).dataset.state`), "done", "复制后没有显示已复制");
    await main(`${clipboardModule}.writeText('')`);
    await clickCenter(command, evaluate, "#current-turn .turn-reply-actions [aria-label=复制回答]");
    await check(async () => (await pasted()).includes("PACKAGED_STREAM_START"), "回答下面的复制按钮没有复制内容");
    const copied = await pasted();
    assert(copied.includes("| 文件/文件夹 | 用途 |") && copied.includes("```python"), "回答复制的不是 Markdown 原文");
    await main(`${clipboardModule}.writeText('')`);
    await clickCenter(command, evaluate, "#current-turn .turn-user-actions [aria-label=复制这条消息]");
    await check(async () => await pasted() === "PACKAGE-MARKDOWN", "用户消息下面的复制按钮没有复制原文");
    // 有文字才有复制：没有回答的轮次（例如被停止的）不显示回答的复制按钮。
    const missing = await evaluate(`[...document.querySelectorAll('#previous-turns .saved-turn')].filter(turn => {
      const asked=turn.querySelector('.saved-question')?.textContent.trim(), answered=turn.querySelector('.stream-text');
      return (asked && !turn.querySelector('.turn-user-actions [aria-label=复制这条消息]'))
        || (answered && !turn.querySelector('.turn-reply-actions [aria-label=复制回答]'));
    }).map(turn => turn.querySelector('.saved-question')?.textContent ?? '')`);
    assert.deepEqual(missing, [], `之前的轮次缺少复制按钮：${missing.join("、")}`);
    return { codeCopied:true, replyCopiedAsMarkdown:true, userMessageCopied:true, savedTurnsCopyable:true };
  } finally {
    await main(`${clipboardModule}.writeText(${JSON.stringify(saved ?? "")})`);
  }
}

export async function verifyMarkdown(evaluate, check) {
  await check(() => evaluate("Boolean(document.querySelector('#current-turn .markdown-body table'))"), "最终程序没有渲染 Markdown 表格");
  const state = await evaluate(`(() => {
    const body=document.querySelector('#current-turn .markdown-body');
    const table=body.querySelector('table'), wrapper=table.closest('.markdown-table');
    const link=body.querySelector('a[href="https://example.com/docs"]'), image=body.querySelector('img[alt="验收图片"]');
    const rect=body.getBoundingClientRect(), tableRect=wrapper.getBoundingClientRect();
    return { tableRows:table.querySelectorAll('tbody tr').length, tableCode:table.querySelector('code')?.textContent,
      heading:Boolean(body.querySelector('h2')), inline:Boolean(body.querySelector('strong')&&body.querySelector('em')&&body.querySelector('del')),
      nestedList:Boolean(body.querySelector('ol li ul')), tasks:[...body.querySelectorAll('input')].map(input=>({checked:input.checked,disabled:input.disabled})),
      quote:Boolean(body.querySelector('blockquote strong')), rule:Boolean(body.querySelector('hr')),
      externalLink:link?.target==='_blank'&&link.rel.includes('noopener'), image:Boolean(image?.getClientRects().length),
      imageContained:Boolean(image&&image.getBoundingClientRect().width<=rect.width+1),
      code:Boolean(body.querySelector('.code-block .tok-keyword')), diff:Boolean(body.querySelector('.code-block .diff-add')),
      safe:!window.__markdownUnsafe&&!body.querySelector('script,[onerror]'),
      tableContained:tableRect.left>=rect.left-1&&tableRect.right<=rect.right+1,
      bodyOverflow:body.scrollWidth-body.clientWidth };
  })()`);
  assert.equal(state.tableRows, 2);
  assert.equal(state.tableCode, "index.html");
  assert.deepEqual(state.tasks, [{ checked:true, disabled:true }, { checked:false, disabled:true }]);
  for (const key of ["heading", "inline", "nestedList", "quote", "rule", "externalLink", "image", "imageContained", "code", "diff", "safe", "tableContained"]) {
    assert.equal(state[key], true, `Markdown ${key} 验收失败`);
  }
  assert(state.bodyOverflow <= 1, "Markdown 输出撑破消息宽度");
  await check(() => evaluate("(()=>{const image=document.querySelector('#current-turn img[alt=\"验收图片\"]');return image?.complete&&image.naturalWidth>0;})()"), "最终程序中的 Markdown 图片未载入");
  return { ...state, imageLoaded:true };
}
