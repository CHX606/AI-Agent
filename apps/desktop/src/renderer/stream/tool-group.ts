/** 工具操作默认收起；查看类合并，其他操作按工具分别汇总。 */
import { streamBullet } from "./bullet";
import { summarizeToolGroup, type ToolRowSummary } from "./tool-group-summary";
import type { PatchSummary } from "./patch-summary";
import "./group.css";

let groups = 0;

export class ToolGroup {
  readonly element: HTMLLIElement;
  private readonly head: HTMLButtonElement;
  private readonly text: HTMLSpanElement;
  private readonly result: HTMLSpanElement;
  private readonly failures: HTMLSpanElement;
  private readonly list: HTMLOListElement;
  private readonly rows: HTMLLIElement[] = [];
  private readonly patches = new Map<HTMLLIElement, PatchSummary>();

  constructor(nested: boolean, readonly kind: string) {
    this.element = document.createElement("li");
    this.element.className = "stream-item stream-group";
    this.element.dataset.kind = kind;
    if (nested) this.element.dataset.nested = "true";
    this.head = document.createElement("button");
    this.head.type = "button";
    this.head.className = "group-head";
    this.head.setAttribute("aria-expanded", "false");
    this.text = document.createElement("span");
    this.text.className = "group-summary";
    this.result = document.createElement("span");
    this.result.className = "group-outcome";
    this.failures = document.createElement("span");
    this.failures.className = "group-failures";
    const chevron = document.createElement("span");
    chevron.className = "group-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "›";
    this.head.append(streamBullet(), this.text, this.result, this.failures, chevron);
    this.list = document.createElement("ol");
    this.list.className = "group-list";
    this.list.id = `tool-group-${++groups}`;
    this.list.hidden = true;
    this.head.setAttribute("aria-controls", this.list.id);
    this.head.addEventListener("click", () => this.toggle());
    this.element.append(this.head, this.list);
  }

  add(row: HTMLLIElement): void {
    this.rows.push(row);
    this.list.append(row);
    this.refresh();
  }

  toggle(open = this.list.hidden): void {
    this.list.hidden = !open;
    this.head.setAttribute("aria-expanded", String(open));
  }

  setPatch(row: HTMLLIElement, summary: PatchSummary | undefined): void {
    if (summary) this.patches.set(row, summary);
    else this.patches.delete(row);
  }

  private summaryRows(): ToolRowSummary[] {
    return this.rows.map(row => ({ tool: row.dataset.tool ?? "", label: row.dataset.label ?? "操作",
      target: row.dataset.target ?? "", tone: row.dataset.tone ?? "neutral",
      summary: row.querySelector<HTMLElement>(".tool-summary")?.textContent ?? "", patch: this.patches.get(row) }));
  }

  /** 进行中显示当前操作，结束后保留结果和异常提示。 */
  refresh(): void {
    const summary = summarizeToolGroup(this.summaryRows());
    this.element.dataset.tone = summary.tone;
    this.text.textContent = summary.text;
    this.text.title = summary.text;
    this.result.textContent = summary.result ? `· ${summary.result}` : "";
    this.result.title = summary.result;
    this.failures.textContent = [summary.failed ? `· ${summary.failed} 个未通过` : "",
      summary.warning ? `· ${summary.warning} 个未完成` : ""].filter(Boolean).join(" ");
    this.failures.dataset.tone = summary.failed ? "error" : "warning";
    this.failures.title = summary.issues;
  }
}
