import { element, formatFileSize } from "../dom";
import { highlight, languageFor } from "../syntax-highlight";
import { renderBreadcrumbs } from "./breadcrumbs";
import type { OpenFile } from "./types";

const HIGHLIGHT_MAX_CHARS = 400_000;
const HIGHLIGHT_MAX_LINES = 8_000;
const LINE_HEIGHT = 20;
const EDITOR_PADDING_TOP = 8;

/** Read-only code rendering, status and per-file cursor/scroll position. */
export class RepositoryPreview {
  private readonly breadcrumbs = element<HTMLElement>("#repository-breadcrumbs");
  private readonly statusLeft = element<HTMLElement>("#repository-status-left");
  private readonly statusRight = element<HTMLElement>("#repository-file-meta");
  private readonly empty = element<HTMLElement>("#repository-preview-empty");
  private readonly content = element<HTMLElement>("#repository-preview-content");
  private readonly notice = element<HTMLElement>("#repository-preview-notice");
  private readonly editor = element<HTMLElement>("#repository-editor");
  private readonly gutter = this.editor.querySelector<HTMLElement>(".editor-gutter")!;
  private readonly line = this.editor.querySelector<HTMLElement>(".editor-current-line")!;
  private readonly code = element<HTMLElement>("#repository-file-content");
  private current: OpenFile | null = null;

  constructor(private readonly workspace: () => string) {
    this.editor.addEventListener("click", (event) => this.selectLine(event));
  }

  clear(): void {
    this.current = null;
    this.breadcrumbs.replaceChildren();
    this.statusLeft.textContent = "只读预览";
    this.statusRight.textContent = "";
    this.code.textContent = this.gutter.textContent = "";
    this.line.hidden = this.notice.hidden = this.content.hidden = true;
    this.empty.hidden = false;
  }

  show(file: OpenFile): void {
    if (this.current && this.current !== file) this.current.scrollTop = this.editor.scrollTop;
    this.current = file;
    renderBreadcrumbs(this.breadcrumbs, this.workspace(), file.entry.path);
    this.empty.hidden = true;
    this.content.hidden = false;
    delete this.notice.dataset.tone;
    if (file.result) {
      this.paintContent(file);
      this.editor.scrollTop = file.scrollTop;
    } else {
      this.code.textContent = this.gutter.textContent = "";
      this.notice.hidden = false;
      this.notice.textContent = file.error ?? "正在读取文件…";
      if (file.error) this.notice.dataset.tone = "error";
    }
    this.placeCurrentLine(file);
    this.paintStatus(file);
  }

  private placeCurrentLine(file: OpenFile): void {
    this.line.hidden = file.line === null;
    if (file.line !== null) this.line.style.top = `${EDITOR_PADDING_TOP + (file.line - 1) * LINE_HEIGHT}px`;
  }

  private paintStatus(file: OpenFile, column = 1): void {
    const result = file.result;
    const language = languageFor(file.entry.path);
    this.statusLeft.textContent = file.line === null ? "只读预览" : `行 ${file.line}，列 ${column}`;
    if (!result) {
      this.statusRight.textContent = file.error ? "读取失败" : "正在读取…";
      return;
    }
    const lines = result.content ? result.content.split("\n").length : 0;
    this.statusRight.textContent = [`${lines} 行`, "UTF-8", language?.name ?? "纯文本", formatFileSize(result.size)].join(" · ");
  }

  private paintContent(file: OpenFile): void {
    const result = file.result!;
    const content = result.content;
    const lineCount = content.split("\n").length;
    this.gutter.textContent = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n");
    this.gutter.style.minWidth = `${Math.max(3, String(lineCount).length) + 2}ch`;
    const large = content.length > HIGHLIGHT_MAX_CHARS || lineCount > HIGHLIGHT_MAX_LINES;
    const tokens = highlight(content, large ? null : languageFor(file.entry.path));
    const fragment = document.createDocumentFragment();
    for (const token of tokens) {
      if (!token.kind) { fragment.append(token.text); continue; }
      const span = document.createElement("span");
      span.className = `tok-${token.kind}`;
      span.textContent = token.text;
      fragment.append(span);
    }
    this.code.replaceChildren(fragment);
    const notices = [
      result.truncated ? "文件较大，仅预览前 1 MB。" : "",
      large && languageFor(file.entry.path) ? "文件较大，已关闭语法着色。" : "",
    ].filter(Boolean);
    this.notice.hidden = notices.length === 0;
    this.notice.textContent = notices.join(" ");
  }

  private columnAt(event: MouseEvent): number {
    const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (!caret || !this.code.contains(caret.startContainer)) return 1;
    const before = document.createRange();
    before.setStart(this.code, 0);
    before.setEnd(caret.startContainer, caret.startOffset);
    const text = before.toString();
    return text.length - text.lastIndexOf("\n");
  }

  private selectLine(event: MouseEvent): void {
    const file = this.current;
    if (!file?.result) return;
    const bounds = this.editor.getBoundingClientRect();
    const y = event.clientY - bounds.top + this.editor.scrollTop - EDITOR_PADDING_TOP;
    const lineCount = file.result.content.split("\n").length;
    file.line = Math.min(lineCount, Math.max(1, Math.floor(y / LINE_HEIGHT) + 1));
    this.placeCurrentLine(file);
    this.paintStatus(file, this.columnAt(event));
  }
}
