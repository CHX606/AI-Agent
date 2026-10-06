import "../src/renderer/styles/theme.css";
import "../src/renderer/styles/base.css";
import "../src/renderer/styles/conversation.css";
import "../src/renderer/styles/markdown.css";
import "../src/renderer/transcript.css";
import { renderMarkdown } from "../src/renderer/markdown";
import { StreamTextBlock } from "../src/renderer/stream/text-block";

declare global { interface Window { markdownAcceptance(): Promise<unknown>; markdownLayout(theme: string): unknown; } }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const source = [
  "# 输出渲染\n## 根目录内容\n### 三级\n#### 四级\n##### 五级\n###### 六级",
  "| 文件 / 文件夹 | 用途 |\n| :--- | ---: |\n| `index.html` | 模板总览页 |\n| `README.md` | 说明文档 |",
  "**粗体**、*斜体*、~~删除~~、`a < b`、[外链](https://example.com/docs)、https://example.com。",
  "3. 第一项\n   - 子项\n     - 更深子项\n4. 第二项\n\n- [x] 已完成\n- [ ] 待办",
  "> 引用内容\n>\n> - 嵌套列表\n>\n> 引用第二段\n\n---\n\n换行  \n下一行",
  "~~~~javascript\nconst message = '<script>只显示代码</script>';\nconsole.log(message);\n~~~~",
  "```diff\n@@ -1 +1 @@\n-旧内容\n+新内容\n```",
  "```unknown\n纯文本 <tag> 不执行\n```",
  `\`\`\`python\nprint('${"长代码".repeat(100)}')\n\`\`\``,
  `| ${Array.from({ length: 10 }, (_, index) => `列${index + 1}`).join(" | ")} |\n| ${Array(10).fill("---").join(" | ")} |\n| ${Array(10).fill("横向滚动表格").join(" | ")} |`,
  "![图片](https://example.com/image.png)\n\n<details open><summary>补充说明</summary><p>安全 HTML 内容</p></details>",
  '<script>window.__markdownExecuted = 1</script>\n\n<style>body{background:red}</style>',
  '<div class="modal" id="private"><a href="https://example.com/" onclick="window.__markdownExecuted = 2">有效外链</a><img src="https://example.com/x.png" onerror="window.__markdownExecuted = 3"></div>',
  '<iframe src="https://example.com/"></iframe><svg onload="alert(1)"></svg><form><button>不允许操作</button><input type="text"></form>',
  '[脚本](javascript:alert(1)) [本地](file:///C:/private.txt) [相对](../README.md) ![禁止数据图](data:image/svg+xml,test)',
].join("\n\n");

function verifyContent(body: HTMLElement): void {
  check(body.querySelectorAll(".markdown-table").length === 2, "表格必须分别渲染且可横向滚动");
  check(body.querySelector("th[align='right']"), `表格必须保留对齐信息：${body.querySelector("table")?.outerHTML}`);
  for (let level = 1; level <= 6; level += 1) check(body.querySelector(`h${level}`), `缺少 ${level} 级标题`);
  check(body.querySelector("ol[start='3'] ul ul"), "嵌套列表层次或列表起始编号丢失");
  check(body.querySelectorAll(".markdown-task-checkbox:disabled").length === 2, "任务列表必须是禁用的勾选框");
  check(body.querySelector<HTMLInputElement>(".markdown-task-checkbox")?.checked, "任务完成状态丢失");
  check(body.querySelectorAll(".code-block").length === 4, "不同语言的代码围栏渲染不完整");
  check(body.querySelector(".tok-keyword"), "代码缺少已有语法高亮");
  check(body.querySelector(".diff-add")?.textContent?.includes("新内容"), "diff 高亮丢失");
  check(body.querySelector("blockquote li") && body.querySelector("hr") && body.querySelector("br"), "引用、分隔线或换行丢失");
  check(body.querySelector("strong") && body.querySelector("em") && body.querySelector("del"), "行内格式不完整");
  check(body.querySelector("details[open] summary"), "安全的折叠说明没有渲染");
  check(!body.querySelector("script, style, iframe, svg, form, button, input:not([type='checkbox'])"), "危险或可操作 HTML 未被清除");
  check(!body.querySelector("[onclick], [onerror], [style], [id], .modal"), "危险属性或应用样式类未被清除");
  check(!Reflect.get(window, "__markdownExecuted"), "模型输出执行了脚本");
  for (const link of body.querySelectorAll("a")) {
    check(/^https?:/u.test(link.href), "不安全或本地链接保留了导航");
    check(link.target === "_blank" && link.rel.includes("noopener"), "外链缺少安全打开策略");
  }
}

window.markdownAcceptance = async () => {
  const body = document.querySelector<HTMLElement>("#rendered")!;
  renderMarkdown(body, source);
  verifyContent(body);
  const stream = document.querySelector<HTMLOListElement>("#stream")!;
  const block = new StreamTextBlock(item => stream.append(item), () => undefined);
  for (let index = 0; index < source.length; index += 61) { block.append(source.slice(index, index + 61)); await frame(); }
  block.end();
  const streamed = stream.querySelector<HTMLElement>(".markdown-body")!;
  verifyContent(streamed);
  check(streamed.innerHTML === body.innerHTML, "流式和历史消息的最终 DOM 必须相同");
  const partial = document.createElement("div");
  renderMarkdown(partial, "```python\nprint('未结束')");
  check(partial.querySelector(".code-block")?.textContent?.includes("未结束"), "未关闭的流式代码块不可读");
  for (const image of document.querySelectorAll<HTMLImageElement>("img")) {
    image.src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="60"><rect width="1800" height="60" fill="#df7440"/></svg>')}`;
  }
  await frame();
  return { tables: 4, headings: 12, streamingMatchesHistory: true, safeHtml: true, codeHighlight: true,
    disabledTaskStates: true, incompleteStream: true, externalLinks: true };
};

window.markdownLayout = theme => {
  document.documentElement.dataset.theme = theme;
  const width = document.documentElement.clientWidth;
  check(document.documentElement.scrollWidth <= width + 1, "渲染内容导致整页横向溢出");
  const table = document.querySelector<HTMLElement>(".markdown-table:last-of-type")
    ?? [...document.querySelectorAll<HTMLElement>(".markdown-table")][1]!;
  check(table.scrollWidth > table.clientWidth, "宽表格必须在自己的区域横向滚动");
  for (const image of document.querySelectorAll("img")) check(image.offsetWidth <= image.parentElement!.clientWidth, "图片撑破消息宽度");
  const token = document.querySelector<HTMLElement>(".tok-keyword")!;
  check(getComputedStyle(token).display === "inline", "语法高亮不能让代码片段各占一行");
  return { theme, viewport: width, pageWidth: document.documentElement.scrollWidth, tableWidth: table.clientWidth,
    tableScrollWidth: table.scrollWidth, tokenColor: getComputedStyle(token).color };
};
