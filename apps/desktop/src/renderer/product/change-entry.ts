export interface Change {
  id: string; status: string;
  files: { path: string; diff: string; truncated: boolean }[];
}

type Review = (id: string, action: "accept" | "undo") => Promise<void>;
const labels: Record<string, string> = { undone: "已撤销", pending: "处理中", accepted: "已保留", applied: "待审阅", unreviewed: "待审阅" };

function diffLine(line: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "diff-line";
  if (line.startsWith("@@")) span.dataset.kind = "hunk";
  else if (line.startsWith("+") && !line.startsWith("+++")) span.dataset.kind = "add";
  else if (line.startsWith("-") && !line.startsWith("---")) span.dataset.kind = "remove";
  span.textContent = `${line}\n`;
  return span;
}

function changeFile(file: Change["files"][number]): HTMLElement {
  const details = document.createElement("details");
  details.className = "change-file";
  details.open = true;
  const summary = document.createElement("summary");
  summary.textContent = file.path;
  summary.title = file.path;
  const pre = document.createElement("pre");
  pre.className = "product-diff";
  pre.tabIndex = 0;
  pre.setAttribute("aria-label", `${file.path} 的文件差异`);
  // 文件内容只当作文字显示，不能让其中的 HTML 变成页面代码。
  for (const line of file.diff.split("\n")) pre.append(diffLine(line));
  details.append(summary, pre);
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

export function createChangeEntry(change: Change, ordinal: number, review: Review): HTMLElement {
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
  for (const file of change.files) article.append(changeFile(file));
  return article;
}
