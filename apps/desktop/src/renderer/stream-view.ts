/** 连续对话流：按事件顺序渲染文字、工具和流程说明。 */
import type { TaskEvent } from "../shared/contracts";
import { object } from "./dom";
import { eventPresentation, isMainAgentText } from "./presentation";
import { StreamStatusLine } from "./stream/status-line";
import { stopEvents } from "./stream/run-status";
import { StreamToolRows } from "./stream/tool-row";
import { StreamTextBlock } from "./stream/text-block";
import { renderMessageImages } from "./attachments/message-images";
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

function activityTitle(title: string, event: TaskEvent, payload: Record<string, unknown>): string {
  if (event.event_type !== "TASK_INTENT_UPDATED" || !Array.isArray(payload.images)) return title;
  const names = payload.images.map(object).map(image => image?.name).filter(name => typeof name === "string");
  return names.length ? `${title} · 图片：${names.join("、")}` : title;
}

class StreamRenderer {
  private readonly follow: boolean;
  private readonly status: StreamStatusLine;
  private readonly tools: StreamToolRows;
  private readonly text: StreamTextBlock;
  private stoppedNote = false;
  private firstTurn = false;
  private stuck: boolean;

  constructor(private readonly options: StreamViewOptions) {
    this.follow = options.follow ?? true;
    this.stuck = this.follow;
    this.status = new StreamStatusLine(options.statusLine, () => this.followBottom());
    this.text = new StreamTextBlock(item => this.append(item), () => this.followBottom());
    this.tools = new StreamToolRows({
      append: item => { this.text.end(); this.append(item); },
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

  private note(title: string, tone: string, nested: boolean): void {
    if (!title) return;
    this.text.end();
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
    this.text.reset();
    this.stoppedNote = false;
    this.firstTurn = false;
    this.stuck = this.follow;
    this.status.reset();
    this.status.paint();
    if (this.follow) requestAnimationFrame(() => this.toBottom());
  }

  detach(): Node[] {
    this.text.end();
    this.preserveStopped();
    const nodes = [...this.options.stream.childNodes];
    this.options.stream.replaceChildren();
    this.tools.clear();
    return nodes;
  }

  dispose(): void { this.text.end(); this.status.dispose(); }
  scrollToEnd(): void { this.stuck = true; requestAnimationFrame(() => this.toBottom()); }

  userNote(message: string, images: unknown = []): void {
    this.text.end();
    const item = document.createElement("li");
    item.className = "stream-item stream-user";
    const mark = document.createElement("span");
    mark.className = "turn-prompt";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "›";
    const copy = document.createElement("p");
    copy.textContent = message;
    item.append(mark, copy);
    renderMessageImages(item, images);
    this.stuck = true;
    this.append(item);
  }

  setStartedAt(value: string | null | undefined): void { this.status.setStartedAt(value); }
  /** 新对话的第一轮：外部工具连接成功的提示只在这一轮显示。 */
  setFirstTurn(value: boolean): void { this.firstTurn = value; }
  setLoading(message: string | null): void { this.status.setLoading(message); this.status.paint(); }

  setStatus(value: string): void {
    this.status.setStatus(value);
    if (this.status.stopped) this.text.end();
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
          this.text.append(payload.text);
        }
        return;
      case "MODEL_REQUESTED":
        this.status.setPhase(nested ? (agent.startsWith("acceptance-") ? "独立验收中" : "子 Agent 调查中") : "思考中");
        if (!nested) this.text.end();
        return;
      case "MODEL_RESPONDED": return;
      case "CONTEXT_COMPACTING":
        // 对话太长时先让模型把旧记录写成摘要，可能要一两分钟；状态行说明在做什么，而不是像卡住。
        if (!nested) this.status.setPhase("整理较早的对话记录");
        return;
      case "EXTERNAL_TOOLS_LOADED":
        // 每轮都会重新连接外部工具；成功只在对话第一轮说一次，连接失败每次都要说。
        if (!this.firstTurn && !(Array.isArray(payload.failed) && payload.failed.length)) return;
        break;
      case "TOOL_REQUESTED":
      case "TOOL_COMPLETED": this.tools.handle(event, agent); return;
      case "AGENT_COMPLETED":
      case "AGENT_FAILED": if (!nested) return;
    }
    const presentation = eventPresentation(event);
    if (presentation && !presentation.remove) this.note(activityTitle(presentation.title, event, payload), presentation.tone, nested);
  }

  finish(input: FinishInput): void {
    this.status.setLoading(null);
    if (input.cancelled || this.status.stopped) { this.setStatus("CANCELLED"); return; }
    if (input.answer) {
      this.text.replace(input.answer);
    }
    if (input.failure) this.showError(input.failure);
    this.setStatus("IDLE");
  }

  showError(message: string): void {
    this.text.end();
    this.status.setLoading(null);
    const item = document.createElement("li");
    item.className = "stream-item stream-error";
    const body = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "任务未完成";
    const copy = document.createElement("p");
    copy.textContent = message;
    body.append(title, copy);
    item.append(body);
    this.append(item);
    this.status.paint();
  }
}

export function createStreamView(options: StreamViewOptions) { return new StreamRenderer(options); }
export type StreamView = ReturnType<typeof createStreamView>;
