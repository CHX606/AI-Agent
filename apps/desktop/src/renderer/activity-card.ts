/** 任务时间线上的一张操作卡片：摘要、可读的详情和折叠的原始数据。 */
import type { ActivityPresentation } from "./presentation";

function appendPayload(pre: HTMLElement, value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
  for (const line of text.split("\n")) {
    const row = document.createElement("span");
    row.className = line.startsWith("+")
      ? "diff-add"
      : line.startsWith("-")
        ? "diff-remove"
        : line.startsWith("@@")
          ? "diff-hunk"
          : "payload-line";
    row.textContent = `${line}\n`;
    pre.append(row);
  }
}

export function createActivityCard(presentation: ActivityPresentation, payload: unknown): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "activity-item";
  item.dataset.tone = presentation.tone;
  const details = document.createElement("wa-details");
  details.className = "operation-card";
  details.setAttribute("appearance", "plain");
  if (presentation.tone === "error") details.setAttribute("open", "");
  const summary = document.createElement("div");
  summary.className = "operation-summary";
  summary.slot = "summary";
  const dot = document.createElement("span");
  dot.className = "event-dot";
  const copy = document.createElement("span");
  copy.className = "operation-copy";
  const title = document.createElement("strong");
  title.textContent = presentation.title;
  const caption = document.createElement("span");
  caption.textContent = presentation.target || presentation.toolName || "Bit Agent";
  copy.append(title, caption);
  const time = document.createElement("time");
  time.textContent = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
  summary.append(dot, copy, time);
  const humanDetail = document.createElement("dl");
  humanDetail.className = "operation-meta";
  const addMeta = (label: string, value: string | undefined): void => {
    if (!value) return;
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    humanDetail.append(term, description);
  };
  addMeta("操作", presentation.title);
  addMeta("目标", presentation.target);
  addMeta("状态", presentation.status);
  addMeta("耗时", presentation.durationMs === undefined ? undefined : `${presentation.durationMs} ms`);
  addMeta("工具", presentation.toolName);
  addMeta("错误码", presentation.errorCode);
  const detail = document.createElement("pre");
  detail.className = "event-payload";
  appendPayload(detail, payload);
  const technical = document.createElement("details");
  technical.className = "technical-detail";
  const technicalSummary = document.createElement("summary");
  technicalSummary.textContent = "查看技术详情";
  technical.append(technicalSummary, detail);
  details.append(summary, humanDetail, technical);
  item.append(details);
  return item;
}
