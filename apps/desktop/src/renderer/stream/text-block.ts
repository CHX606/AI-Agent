/** 流式文字延后到动画帧渲染；切换工具或保存过程前立即刷新。 */
import { registerMarkdown } from "../copy-button";
import { renderMarkdown } from "../markdown";
import { streamBullet } from "./bullet";

interface TextBlock { body: HTMLElement; raw: string }

export class StreamTextBlock {
  private current: TextBlock | null = null;
  private pending = "";
  private frame: number | null = null;

  constructor(
    private readonly appendItem: (item: HTMLElement) => void,
    private readonly afterRender: () => void,
  ) {}

  private create(): TextBlock {
    const item = document.createElement("li");
    item.className = "stream-item stream-text";
    const body = document.createElement("div");
    body.className = "markdown-body";
    const block: TextBlock = { body, raw: "" };
    item.append(streamBullet(), body);
    registerMarkdown(item, () => block.raw);
    this.appendItem(item);
    return block;
  }

  append(delta: string): void {
    if (!delta) return;
    if (!this.current) {
      this.pending += delta;
      if (!this.pending.trim()) return;
      this.current = this.create();
      this.current.raw = this.pending;
      this.pending = "";
    } else {
      this.current.raw += delta;
    }
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.flush();
    });
  }

  private cancelFrame(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private flush(): void {
    this.cancelFrame();
    if (!this.current) return;
    renderMarkdown(this.current.body, this.current.raw);
    this.afterRender();
  }

  end(): void {
    this.flush();
    this.current = null;
    this.pending = "";
  }

  replace(answer: string): void {
    if (!answer.trim()) return;
    this.current ??= this.create();
    this.current.raw = answer;
    this.flush();
  }

  reset(): void {
    this.cancelFrame();
    this.current = null;
    this.pending = "";
  }
}
