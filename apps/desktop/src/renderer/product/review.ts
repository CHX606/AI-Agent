import type { TaskRequestInput } from "../../shared/contracts.js";
import { createGitCommitPanel, type GitCommitPanel } from "../git-commit-panel.js";
import type { DiffMode } from "../diff/view.js";
import { createChangeEntry, type Change } from "./change-entry.js";
import type { ProductDialog } from "./dialog.js";

interface ReviewView {
  dialog: ProductDialog; body: HTMLElement; list: HTMLElement;
  input: TaskRequestInput; git: GitCommitPanel;
  changes: Change[]; mode: DiffMode;
}

const MODE_KEY = "bit-agent.diff-mode";

function savedMode(): DiffMode {
  try { return localStorage.getItem(MODE_KEY) === "split" ? "split" : "unified"; }
  catch { return "unified"; }
}

function modeToggle(view: ReviewView): HTMLElement {
  const group = document.createElement("div");
  group.className = "diff-mode";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "差异显示方式");
  for (const [mode, label] of [["unified", "合并"], ["split", "并排"]] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.mode = mode;
    button.textContent = label;
    button.setAttribute("aria-pressed", String(view.mode === mode));
    button.addEventListener("click", () => {
      view.mode = mode;
      try { localStorage.setItem(MODE_KEY, mode); } catch { /* 只是显示偏好，存不下就算了 */ }
      for (const item of group.querySelectorAll("button")) item.setAttribute("aria-pressed", String(item === button));
      renderChanges(view);
    });
    group.append(button);
  }
  return group;
}

function renderChanges(view: ReviewView): void {
  view.list.replaceChildren();
  if (!view.changes.length) {
    const empty = document.createElement("p");
    empty.className = "product-empty";
    empty.textContent = "本轮任务还没有修改文件。";
    view.list.append(empty);
  }
  for (const [index, value] of [...view.changes].reverse().entries()) {
    view.list.append(createChangeEntry(value, view.changes.length - index,
      (id, action) => reviewChange(view, id, action), view.mode));
  }
}

async function reviewChange(view: ReviewView, id: string, action: "accept" | "undo"): Promise<void> {
  if (action === "undo" && !window.confirm("撤销本次改动？如果文件后来被编辑，系统会拒绝覆盖。")) return;
  const buttons = [...view.list.querySelectorAll<HTMLButtonElement>("button")];
  const disabled = buttons.map((item) => item.disabled);
  buttons.forEach((item) => { item.disabled = true; });
  try {
    await window.bitAgent.reviewChange({ ...view.input, changeId: id, action });
    await drawChanges(view);
    if (action === "undo") await view.git.refresh();
  } catch (error) { view.dialog.feedback(view.body, error); }
  finally { buttons.forEach((item, position) => { item.disabled = disabled[position] ?? false; }); }
}

async function drawChanges(view: ReviewView): Promise<void> {
  try {
    const payload = await window.bitAgent.getChanges(view.input);
    if (!view.dialog.active(view.body)) return;
    view.dialog.ready(view.body);
    view.changes = (Array.isArray(payload.changes) ? payload.changes : []) as Change[];
    renderChanges(view);
  } catch (error) { view.dialog.feedback(view.body, error); }
}

export async function showReview(dialog: ProductDialog, current: () => TaskRequestInput): Promise<void> {
  const body = dialog.open("review", "审阅改动", "查看本轮任务写入的文件，决定保留或撤销。");
  const note = document.createElement("div");
  note.className = "review-explanation";
  note.innerHTML = `<p>改动已经写入文件。保留不会重复写入；撤销仅在任务结束后可用。</p>
    <details><summary>撤销时如何保护文件？</summary><p>如果文件后来被编辑，系统会拒绝覆盖。多次修改同一文件时，请从最新一次往前撤销。</p></details>`;
  body.append(note);
  const list = document.createElement("div");
  list.className = "change-list";
  body.append(list);
  let input: TaskRequestInput;
  try { input = current(); }
  catch {
    dialog.ready(body);
    list.className = "product-empty";
    list.textContent = "选择一段会话后，就能查看该任务的文件改动。";
    return;
  }
  const git = createGitCommitPanel(input, (value, success) => dialog.feedback(body, value, success));
  list.before(git.element);
  void git.refresh();
  const view: ReviewView = { dialog, body, list, input, git, changes: [], mode: savedMode() };
  const toolbar = document.createElement("div");
  toolbar.className = "change-list-toolbar";
  toolbar.append(modeToggle(view));
  list.before(toolbar);
  await drawChanges(view);
}

export function mountReviewButton(dialog: ProductDialog, current: () => TaskRequestInput): void {
  const button = document.createElement("button");
  button.type = "button";
  button.id = "review-changes";
  button.className = "review-changes-button";
  button.textContent = "审阅改动";
  document.querySelector("#changed-files")?.closest(".inspector-section")
    ?.querySelector(".inspector-heading")?.append(button);
  button.addEventListener("click", () => { void showReview(dialog, current); });
}
