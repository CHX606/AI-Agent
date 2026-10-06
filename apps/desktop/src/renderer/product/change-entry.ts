import { diffStats, parseUnifiedDiff } from "../diff/model.js";
import { renderDiffTable, type DiffMode } from "../diff/view.js";

export interface Change {
  id: string; status: string;
  files: { path: string; diff: string; truncated: boolean }[];
}

type Review = (id: string, action: "accept" | "undo") => Promise<void>;
const labels: Record<string, string> = { undone: "已撤销", pending: "处理中", accepted: "已保留", applied: "待审阅", unreviewed: "待审阅" };

function fileSummary(file: Change["files"][number]): HTMLElement {
  const summary = document.createElement("summary");
  summary.title = file.path;
  const path = document.createElement("span");
  path.textContent = file.path;
  const { added, removed } = diffStats(parseUnifiedDiff(file.diff));
  const stats = document.createElement("span");
  stats.className = "diff-stats";
  stats.innerHTML = '<span class="diff-stats-add"></span><span class="diff-stats-remove"></span>';
  stats.firstElementChild!.textContent = `+${added}`;
  stats.lastElementChild!.textContent = `−${removed}`;
  summary.append(path, stats);
  return summary;
}

function changeFile(file: Change["files"][number], mode: DiffMode): HTMLElement {
  const details = document.createElement("details");
  details.className = "change-file";
  details.open = true;
  details.append(fileSummary(file), renderDiffTable(file.path, file.diff, mode));
  if (file.truncated) {
    const truncated = document.createElement("p");
    truncated.className = "diff-truncated";
    truncated.textContent = "内容较长，这里只显示部分差异。";
    details.append(truncated);
  }
  return details;
}

function changeActions(change: Change, review: Review): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "change-actions";
  for (const [action, label] of [["accept", "保留改动"], ["undo", "撤销这次改动"]] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action === "undo" ? "button-secondary change-undo" : "button-secondary";
    button.textContent = label;
    button.disabled = change.status === "undone" || change.status === "pending";
    button.onclick = () => review(change.id, action);
    actions.append(button);
  }
  return actions;
}

export function createChangeEntry(change: Change, ordinal: number, review: Review, mode: DiffMode): HTMLElement {
  const article = document.createElement("article");
  article.className = "change-entry";
  const toolbar = document.createElement("div");
  toolbar.className = "change-entry-toolbar";
  const title = document.createElement("strong");
  title.textContent = `第 ${ordinal} 次改动`;
  const status = document.createElement("span");
  status.className = "change-status";
  status.dataset.status = change.status;
  status.textContent = labels[change.status] ?? change.status;
  toolbar.append(title, status, changeActions(change, review));
  article.append(toolbar);
  for (const file of change.files) article.append(changeFile(file, mode));
  return article;
}
