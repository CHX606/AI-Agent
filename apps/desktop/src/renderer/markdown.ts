import { decorateMarkdown } from "./markdown/content";
import { markdownFragment } from "./markdown/parser";

/** 流式内容和历史消息共用完整的 CommonMark / GFM 渲染入口。 */
export function renderMarkdown(container: HTMLElement, markdown: string): void {
  const fragment = markdownFragment(markdown);
  decorateMarkdown(fragment);
  container.replaceChildren(fragment);
}
