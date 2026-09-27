/** 长期记忆面板里的一条记忆：类型、标题、内容、适用条件和来源。只把内容当文字显示。 */
import type { LongTermMemory } from "../shared/contracts";

const kindLabels: Record<LongTermMemory["kind"], string> = {
  PROCEDURE: "做法",
  FACT: "事实",
  DECISION: "决定",
  EPISODE: "经历",
  PREFERENCE: "偏好",
};

export function memoryKindLabel(kind: string): string {
  return kindLabels[kind as LongTermMemory["kind"]] ?? "经验";
}

/** 项目编号是规范化后的目录路径，展示时只取最后一级目录名。 */
export function memoryProjectName(projectId: string | null): string {
  if (!projectId) return "通用";
  return projectId.split(/[\\/]/u).filter(Boolean).at(-1) ?? projectId;
}

export function memoryMeta(memory: LongTermMemory, showProject: boolean): string {
  const date = new Date(memory.updated_at);
  const time = Number.isNaN(date.valueOf())
    ? ""
    : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const parts = [
    showProject ? `项目：${memoryProjectName(memory.project_id)}` : "",
    time ? `更新于 ${time}` : "",
    `来自 ${memory.source_run_ids.length} 次任务`,
  ];
  return parts.filter(Boolean).join(" · ");
}

export function createMemoryEntry(
  memory: LongTermMemory,
  showProject: boolean,
  onDelete: (button: HTMLButtonElement) => void,
): HTMLElement {
  const article = document.createElement("article");
  article.className = "memory-entry";
  article.dataset.memoryId = memory.id;

  const header = document.createElement("div");
  header.className = "memory-entry-header";
  const kind = document.createElement("span");
  kind.className = "memory-kind";
  kind.dataset.kind = memory.kind;
  kind.textContent = memoryKindLabel(memory.kind);
  const title = document.createElement("strong");
  title.textContent = memory.title;
  title.title = memory.memory_key;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button-secondary memory-delete";
  remove.textContent = "删除";
  remove.setAttribute("aria-label", `删除记忆：${memory.title}`);
  remove.onclick = () => onDelete(remove);
  header.append(kind, title, remove);

  const content = document.createElement("p");
  content.className = "memory-content";
  content.textContent = memory.content;
  const applicability = document.createElement("p");
  applicability.className = "memory-applicability";
  applicability.textContent = `适用：${memory.applicability}`;
  const meta = document.createElement("p");
  meta.className = "memory-meta";
  meta.textContent = memoryMeta(memory, showProject);

  article.append(header, content, applicability, meta);
  return article;
}
