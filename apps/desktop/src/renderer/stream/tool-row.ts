import type { TaskEvent } from "../../shared/contracts";
import { object } from "../dom";
import { eventPresentation, type ActivityPresentation } from "../presentation";
import { renderDiff, type FileDiff } from "./tool-diff";

export function streamBullet(): HTMLSpanElement {
  const mark = document.createElement("span");
  mark.className = "stream-bullet";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "●";
  return mark;
}

function operationLabel(presentation: ActivityPresentation, payload: Record<string, unknown>): string {
  const operation = object(payload.operation);
  if (/^mcp__/u.test(presentation.toolName ?? "")) return "外部工具";
  return typeof operation?.label === "string" ? operation.label : presentation.toolName ?? "操作";
}

function toolItem(label: string, target: string, agent: string): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "stream-item stream-tool";
  if (agent !== "main") item.dataset.nested = "true";
  item.innerHTML = `<button class="tool-head" type="button" aria-expanded="false"></button>
    <div class="tool-result"><span class="tool-branch" aria-hidden="true">⎿</span><span class="tool-summary"></span></div>
    <div class="tool-diff" hidden></div><div class="tool-detail" hidden></div>`;
  const head = item.querySelector<HTMLButtonElement>(".tool-head")!;
  const name = document.createElement("span");
  name.className = "tool-label";
  name.textContent = label;
  const destination = document.createElement("span");
  destination.className = "tool-target";
  destination.textContent = target;
  head.append(streamBullet(), name, destination);
  head.addEventListener("click", () => {
    const detail = item.querySelector<HTMLElement>(".tool-detail")!;
    detail.hidden = !detail.hidden;
    head.setAttribute("aria-expanded", String(!detail.hidden));
  });
  return item;
}

function toolFacts(presentation: ActivityPresentation): HTMLDListElement {
  const facts = document.createElement("dl");
  const rows: [string, string | undefined][] = [
    ["状态", presentation.status], ["工具", presentation.toolName], ["错误码", presentation.errorCode],
  ];
  for (const [term, value] of rows) {
    if (!value) continue;
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    facts.append(dt, dd);
  }
  return facts;
}

function renderDetails(item: HTMLLIElement, presentation: ActivityPresentation, event: TaskEvent): void {
  const detail = item.querySelector<HTMLElement>(".tool-detail")!;
  const raw = document.createElement("pre");
  raw.className = "event-payload";
  raw.textContent = JSON.stringify(event.data, null, 2);
  detail.replaceChildren(toolFacts(presentation), raw);
}

function resultSummary(presentation: ActivityPresentation, payload: Record<string, unknown>): string {
  const summary = typeof payload.summary === "string" ? payload.summary : "";
  const duration = typeof payload.duration_ms === "number" && payload.duration_ms >= 1000
    ? ` · ${(payload.duration_ms / 1000).toFixed(1)}s` : "";
  return `${presentation.tone === "neutral" ? presentation.title : summary || presentation.status || "完成"}${duration}`;
}

interface ToolRowsOptions {
  append(item: HTMLElement): void;
  loadDiff(callId: string): Promise<FileDiff[]>;
  setPhase(phase: string): void;
}

export class StreamToolRows {
  private readonly items = new Map<string, HTMLLIElement>();
  private count = 0;
  private stopped = false;

  constructor(private readonly options: ToolRowsOptions) {}
  reset(): void { this.clear(); this.count = 0; this.stopped = false; }
  clear(): void { this.items.clear(); }
  operations(): number { return this.count; }

  setStatus(value: string, stopped: boolean): void {
    this.stopped = stopped;
    for (const item of this.items.values()) {
      if (item.dataset.tone !== "running" && item.dataset.stopped !== "true") continue;
      item.dataset.tone = stopped ? "neutral" : "running";
      item.dataset.stopped = String(stopped);
      item.querySelector<HTMLElement>(".tool-summary")!.textContent = stopped ? "已停止"
        : value === "WAITING_FOR_INPUT" ? "等待你回应…" : "运行中…";
    }
  }

  handle(event: TaskEvent, agent: string): void {
    const presentation = eventPresentation(event);
    if (!presentation) return;
    const data = object(event.data);
    const payload = object(data?.payload) ?? data ?? {};
    const label = operationLabel(presentation, payload);
    let item = this.items.get(presentation.key);
    if (!item) {
      if (this.stopped) return;
      item = toolItem(label, presentation.target ?? "", agent);
      this.items.set(presentation.key, item);
      this.count += 1;
      this.options.append(item);
    }
    const finished = event.event_type === "TOOL_COMPLETED";
    item.dataset.tone = this.stopped && !finished ? "neutral" : presentation.tone;
    item.dataset.stopped = String(this.stopped && !finished);
    item.querySelector<HTMLElement>(".tool-summary")!.textContent = finished
      ? resultSummary(presentation, payload) : this.stopped ? "已停止" : "运行中…";
    renderDetails(item, presentation, event);
    this.loadToolDiff(item, presentation, payload, finished);
    if (agent === "main") this.options.setPhase(finished ? "思考中" : `${label}…`);
  }

  private loadToolDiff(item: HTMLLIElement, presentation: ActivityPresentation,
    payload: Record<string, unknown>, finished: boolean): void {
    const callId = typeof payload.tool_call_id === "string" ? payload.tool_call_id : "";
    if (!finished || presentation.toolName !== "apply_patch" || presentation.tone !== "success" || !callId) return;
    const container = item.querySelector<HTMLElement>(".tool-diff")!;
    void this.options.loadDiff(callId).then(files => {
      if (files.length) renderDiff(container, files);
    }).catch(error => {
      container.hidden = false;
      container.textContent = `无法加载文件差异：${error instanceof Error ? error.message : String(error)}`;
    });
  }
}
