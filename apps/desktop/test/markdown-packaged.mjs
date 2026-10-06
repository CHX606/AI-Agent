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
