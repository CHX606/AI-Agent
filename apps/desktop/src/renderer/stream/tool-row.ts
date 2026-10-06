import type { TaskEvent } from "../../shared/contracts";
import { object } from "../dom";
import { eventPresentation, type ActivityPresentation } from "../presentation";
import { formatDuration } from "./run-status";
import { renderDiff, type FileDiff } from "./tool-diff";
import { ToolGroup } from "./tool-group";
import { toolGroupKind } from "./tool-group-summary";
import { patchDiffSummary, patchPaths } from "./patch-summary";

function operationLabel(presentation: ActivityPresentation, payload: Record<string, unknown>): string {
  const operation = object(payload.operation);
  if (/^mcp__browser__/u.test(presentation.toolName ?? "")) return "浏览器";
  if (/^mcp__/u.test(presentation.toolName ?? "")) return "外部工具";
  return typeof operation?.label === "string" ? operation.label : presentation.toolName ?? "操作";
}

function shortTarget(value: string): string {
  return value.length > 60 ? `…${value.slice(-58)}` : value;
}

function toolItem(label: string, target: string, toolName: string, agent: string): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "stream-item stream-tool";
  if (agent !== "main") item.dataset.nested = "true";
  Object.assign(item.dataset, { tool: toolName, label, target: shortTarget(target) });
  item.innerHTML = `<button class="tool-head" type="button" aria-expanded="false"></button>
    <div class="tool-result"><span class="tool-branch" aria-hidden="true">⎿</span><span class="tool-summary"></span></div>
    <div class="tool-diff" hidden></div><div class="tool-detail" hidden></div><ol class="tool-children"></ol>`;
  const head = item.querySelector<HTMLButtonElement>(".tool-head")!;
  const name = document.createElement("span");
  name.className = "tool-label";
  name.textContent = label;
  const destination = document.createElement("span");
  destination.className = "tool-target";
  destination.textContent = target;
  head.append(name, destination);
  head.addEventListener("click", () => {
    const detail = item.querySelector<HTMLElement>(".tool-detail")!;
    detail.hidden = !detail.hidden;
    head.setAttribute("aria-expanded", String(!detail.hidden));
  });
  return item;
}

/** 点开工具行显示可读的执行信息，原始事件仅供内部处理。 */
function renderDetails(item: HTMLLIElement, presentation: ActivityPresentation, summary: string): void {
  const facts = document.createElement("dl");
  const ms = presentation.durationMs;
  const duration = ms === undefined ? undefined : ms < 1000 ? `${Math.round(ms)} 毫秒` : formatDuration(ms);
  const rows: [string, string | undefined][] = [
    ["状态", presentation.status], ["结果", summary || undefined], ["用时", duration],
    ["对象", presentation.target || undefined], ["错误码", presentation.errorCode],
  ];
  for (const [term, value] of rows) {
    if (!value) continue;
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    facts.append(dt, dd);
  }
  item.querySelector<HTMLElement>(".tool-detail")!.replaceChildren(facts);
}

function resultSummary(presentation: ActivityPresentation, payload: Record<string, unknown>): string {
  const summary = typeof payload.summary === "string" ? payload.summary : "";
  const duration = typeof payload.duration_ms === "number" && payload.duration_ms >= 1000
    ? ` · ${formatDuration(payload.duration_ms)}` : "";
  return `${presentation.tone === "neutral" ? presentation.title : summary || presentation.status || "完成"}${duration}`;
}

interface ToolRowsOptions {
  append(item: HTMLElement): void;
  loadDiff(callId: string): Promise<FileDiff[]>;
  setPhase(phase: string): void;
}

export class StreamToolRows {
  private readonly items = new Map<string, HTMLLIElement>();
  private readonly groupOf = new Map<HTMLLIElement, ToolGroup>();
  private readonly nested = new Map<string, ToolGroup>();
  private readonly lastRow = new Map<string, HTMLLIElement>();
  private open: ToolGroup | null = null;
  private count = 0;
  private stopped = false;

  constructor(private readonly options: ToolRowsOptions) {}
  reset(): void { this.clear(); this.count = 0; this.stopped = false; }
  clear(): void {
    this.items.clear(); this.groupOf.clear(); this.nested.clear(); this.lastRow.clear(); this.open = null;
  }
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
    for (const group of new Set(this.groupOf.values())) group.refresh();
  }

  /** 同类连续操作进同一组；中间插入文字或另一类操作时另起一组。 */
  private mainGroup(kind: string): ToolGroup {
    if (this.open?.kind === kind && this.open.element.isConnected && !this.open.element.nextElementSibling) return this.open;
    this.open = new ToolGroup(false, kind);
    this.options.append(this.open.element);
    return this.open;
  }

  /** 独立验收、调查子 Agent 的步骤收进它们上级那一行（verify_task / delegate_tasks）下面。 */
  private nestedGroup(agent: string, kind: string): ToolGroup {
    const existing = this.nested.get(agent);
    if (existing?.kind === kind) return existing;
    const group = new ToolGroup(true, kind);
    const parent = this.lastRow.get(agent.startsWith("acceptance-") ? "verify_task" : "delegate_tasks");
    if (parent) {
      delete group.element.dataset.nested;
      parent.querySelector(".tool-children")!.append(group.element);
    } else this.options.append(group.element);
    this.nested.set(agent, group);
    return group;
  }

  private place(item: HTMLLIElement, toolName: string, agent: string): void {
    const kind = toolGroupKind(toolName);
    const group = agent !== "main" ? this.nestedGroup(agent, kind) : this.mainGroup(kind);
    delete item.dataset.nested;
    this.groupOf.set(item, group);
    group.add(item);
    if (agent === "main") this.lastRow.set(toolName, item);
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
      item = toolItem(label, presentation.target ?? "", presentation.toolName ?? "", agent);
      this.items.set(presentation.key, item);
      this.count += 1;
      this.place(item, presentation.toolName ?? "", agent);
    }
    const finished = event.event_type === "TOOL_COMPLETED";
    const summary = finished ? resultSummary(presentation, payload) : this.stopped ? "已停止" : "运行中…";
    item.dataset.tone = this.stopped && !finished ? "neutral" : presentation.tone;
    item.dataset.stopped = String(this.stopped && !finished);
    item.querySelector<HTMLElement>(".tool-summary")!.textContent = summary;
    renderDetails(item, presentation, finished ? summary : "");
    if (finished && presentation.toolName === "apply_patch" && presentation.tone === "success") {
      this.groupOf.get(item)?.setPatch(item, patchPaths(payload));
    }
    this.groupOf.get(item)?.refresh();
    this.loadToolDiff(item, presentation, payload, finished);
    if (agent === "main") this.options.setPhase(finished ? "思考中" : `${label}…`);
  }

  private loadToolDiff(item: HTMLLIElement, presentation: ActivityPresentation,
    payload: Record<string, unknown>, finished: boolean): void {
    const callId = typeof payload.tool_call_id === "string" ? payload.tool_call_id : "";
    if (!finished || presentation.toolName !== "apply_patch" || presentation.tone !== "success" || !callId) return;
    const container = item.querySelector<HTMLElement>(".tool-diff")!;
    void this.options.loadDiff(callId).then(files => {
      if (!files.length) return;
      renderDiff(container, files);
      const changes = patchDiffSummary(files);
      const counts = changes.added === undefined ? `修改 ${changes.paths.length} 个文件`
        : `${changes.paths.length > 1 ? `${changes.paths.length} 个文件 ` : ""}+${changes.added} −${changes.removed}`;
      item.querySelector<HTMLElement>(".tool-summary")!.textContent = resultSummary(presentation, { ...payload, summary: counts });
      this.groupOf.get(item)?.setPatch(item, changes);
      this.groupOf.get(item)?.refresh();
    }).catch(error => {
      container.hidden = false;
      container.textContent = `无法加载文件差异：${error instanceof Error ? error.message : String(error)}`;
    });
  }
}
