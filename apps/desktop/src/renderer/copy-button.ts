/** 复制按钮：点击后复制当前文本，图标短暂变成对勾。 */
import "./copy-button.css";

const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
const DONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';

/** 回答文字行对应的 Markdown 原文；整轮复制时按显示顺序读取。 */
const markdownSources = new WeakMap<Element, () => string>();

export function registerMarkdown(item: Element, source: () => string): void {
  markdownSources.set(item, source);
}

/** 这一轮显示出来的全部回答文字，段落之间空一行。 */
export function replyMarkdown(stream: Element): string {
  return [...stream.querySelectorAll(":scope > .stream-text")]
    .map(item => markdownSources.get(item)?.().trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}

export function copyButton(text: () => string, label: string, className: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = COPY_ICON;
  let timer: number | undefined;
  button.addEventListener("click", async event => {
    event.stopPropagation();
    window.clearTimeout(timer);
    try {
      // 页面的 Clipboard API 在窗口没有焦点时会拒绝，由主进程写入更可靠。
      await window.bitAgent.copyText(text());
      button.dataset.state = "done";
      button.innerHTML = DONE_ICON;
      button.title = "已复制";
    } catch {
      button.dataset.state = "error";
      button.title = "复制失败";
    }
    timer = window.setTimeout(() => {
      delete button.dataset.state;
      button.innerHTML = COPY_ICON;
      button.title = label;
    }, 1500);
  });
  return button;
}
