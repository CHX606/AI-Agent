/** 连续对话流：按事件顺序渲染文字、工具和流程说明。 */
import type { TaskEvent } from "../shared/contracts";
import { object } from "./dom";
import { renderMarkdown } from "./markdown";
import { eventPresentation, isMainAgentText } from "./presentation";
import { StreamStatusLine } from "./stream/status-line";
import { stopEvents } from "./stream/run-status";
import { StreamToolRows, streamBullet } from "./stream/tool-row";
import type { FileDiff } from "./stream/tool-diff";
import "./transcript.css";

export type { FileDiff } from "./stream/tool-diff";
export { formatElapsed } from "./stream/run-status";

export interface StreamViewOptions {
  stream: HTMLOListElement;
  statusLine?: HTMLElement;
  scroller: HTMLElement;
  follow?: boolean;
  loadDiff(callId: string): Promise<FileDiff[]>;
}

export interface FinishInput {
  answer: string | null;
  failure: string | null;
  cancelled: boolean;
}

class StreamRenderer {
  private readonly follow: boolean;
  private readonly status: StreamStatusLine;
  private readonly tools: StreamToolRows;
  private text: { body: HTMLElement; raw: string } | null = null;
  private renderScheduled = false;
  private stoppedNote = false;
  private stuck: boolean;

  constructor(private readonly options: StreamViewOptions) {
    this.follow = options.follow ?? true;
    this.stuck = this.follow;
    this.status = new StreamStatusLine(options.statusLine, () => this.followBottom());
    this.tools = new StreamToolRows({
      append: item => { this.text = null; this.append(item); },
      loadDiff: options.loadDiff,
      setPhase: phase => this.status.setPhase(phase),
    });
    if (this.follow) {
      options.scroller.addEventListener("scroll", () => {
        const scroller = this.options.scroller;
        this.stuck = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
      }, { passive: true });
      new ResizeObserver(() => this.followBottom()).observe(options.scroller);
    }
  }

  private toBottom(): void {
    this.options.scroller.scrollTo({ top: this.options.scroller.scrollHeight, behavior: "instant" });
  }
  private followBottom(): void { if (this.stuck) this.toBottom(); }
  private append(item: HTMLElement): void { this.options.stream.append(item); this.followBottom(); }

  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      if (!this.text) return;
      renderMarkdown(this.text.body, this.text.raw);
      this.followBottom();
    });
  }

  private textBlock(): { body: HTMLElement; raw: string } {
    const item = document.createElement("li");
    item.className = "stream-item stream-text";
    const body = document.createElement("div");
    body.className = "markdown-body";
    item.append(streamBullet(), body);
    this.append(item);
    return { body, raw: "" };
  }

  private appendText(delta: string): void {
    this.text ??= this.textBlock();
    this.text.raw += delta;
    this.scheduleRender();
  }

  private note(title: string, tone: string, nested: boolean): void {
    if (!title) return;
    this.text = null;
    const item = document.createElement("li");
    item.className = "stream-item stream-note";
    item.dataset.tone = tone;
    if (nested) item.dataset.nested = "true";
    const mark = document.createElement("span");
    mark.className = "stream-note-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "※";
    const copy = document.createElement("span");
    copy.textContent = title;
    item.append(mark, copy);
    this.append(item);
  }

  private preserveStopped(): void {
    if (!this.status.stopped || this.stoppedNote) return;
    this.stoppedNote = true;
    this.note("已停止", "neutral", false);
  }

  reset(): void {
    this.options.stream.replaceChildren();
    this.tools.reset();
    this.text = null;
    this.stoppedNote = false;
    this.stuck = this.follow;
    this.status.reset();
    this.status.paint();
    if (this.follow) requestAnimationFrame(() => this.toBottom());
  }

  detach(): Node[] {
    this.preserveStopped();
    const nodes = [...this.options.stream.childNodes];
    this.options.stream.replaceChildren();
    this.tools.clear();
    this.text = null;
    return nodes;
  }

  dispose(): void { this.status.dispose(); }
  scrollToEnd(): void { this.stuck = true; requestAnimationFrame(() => this.toBottom()); }

  userNote(message: string): void {
    this.text = null;
    const item = document.createElement("li");
    item.className = "stream-item stream-user";
    const mark = document.createElement("span");
    mark.className = "turn-prompt";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "›";
    const copy = document.createElement("p");
    copy.textContent = message;
    item.append(mark, copy);
    this.stuck = true;
    this.append(item);
  }

  setStartedAt(value: string | null | undefined): void { this.status.setStartedAt(value); }
  setLoading(message: string | null): void { this.status.setLoading(message); this.status.paint(); }

  setStatus(value: string): void {
    this.status.setStatus(value);
    this.tools.setStatus(value, this.status.stopped);
    this.status.paint();
    if (!this.options.statusLine) this.preserveStopped();
    this.followBottom();
  }

  operations(): number { return this.tools.operations(); }

  private handleControl(event: TaskEvent, data: Record<string, unknown> | null): boolean {
    if (stopEvents.has(event.event_type)) {
      this.setStatus(event.event_type.includes("PAUSE") ? "PAUSED" : "CANCELLED");
      return true;
    }
    if (event.event_type === "TASK_FINISHED" && data?.status === "CANCELLED") {
      this.setStatus("CANCELLED");
      return true;
    }
    if (event.event_type !== "TASK_RESUMED" || !this.status.resume()) return false;
    this.tools.setStatus("RUNNING", false);
    this.status.paint();
    return true;
  }

  handle(event: TaskEvent): void {
    const data = object(event.data);
    if (this.handleControl(event, data)) return;
    const payload = object(data?.payload) ?? data ?? {};
    const agent = typeof data?.agent_id === "string" ? data.agent_id : "main";
    const nested = agent !== "main";
    if (this.status.stopped) {
      if (event.event_type === "TOOL_COMPLETED") this.tools.handle(event, agent);
      return;
    }
    switch (event.event_type) {
      case "MODEL_TEXT_DELTA":
        if (isMainAgentText(data) && typeof payload.text === "string") {
          this.status.setPhase("回答中");
          this.appendText(payload.text);
        }
        return;
      case "MODEL_REQUESTED":
        this.status.setPhase(nested ? (agent.startsWith("acceptance-") ? "独立验收中" : "子 Agent 调查中") : "思考中");
        if (!nested) this.text = null;
        return;
      case "MODEL_RESPONDED": return;
      case "TOOL_REQUESTED":
      case "TOOL_COMPLETED": this.tools.handle(event, agent); return;
      case "AGENT_COMPLETED":
      case "AGENT_FAILED": if (!nested) return;
    }
    const presentation = eventPresentation(event);
    if (presentation && !presentation.remove) this.note(presentation.title, presentation.tone, nested);
  }

  finish(input: FinishInput): void {
    this.status.setLoading(null);
    if (input.cancelled || this.status.stopped) { this.setStatus("CANCELLED"); return; }
    if (input.answer) {
      if (!this.text || !this.options.stream.lastElementChild?.classList.contains("stream-text")) this.text = this.textBlock();
      this.text.raw = input.answer;
      renderMarkdown(this.text.body, this.text.raw);
      this.followBottom();
    }
    if (input.failure) this.showError(input.failure);
    this.setStatus("IDLE");
  }

  showError(message: string): void {
    this.text = null;
    this.status.setLoading(null);
    const item = document.createElement("li");
    item.className = "stream-item stream-error";
    const body = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "任务未完成";
    const copy = document.createElement("p");
    copy.textContent = message;
    body.append(title, copy);
    item.append(streamBullet(), body);
    this.append(item);
    this.status.paint();
  }
}

export function createStreamView(options: StreamViewOptions) { return new StreamRenderer(options); }
export type StreamView = ReturnType<typeof createStreamView>;
