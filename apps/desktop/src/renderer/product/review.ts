import type { TaskRequestInput } from "../../shared/contracts.js";
import { createGitCommitPanel, type GitCommitPanel } from "../git-commit-panel.js";
import { createChangeEntry, type Change } from "./change-entry.js";
import type { ProductDialog } from "./dialog.js";

interface ReviewView {
  dialog: ProductDialog; body: HTMLElement; list: HTMLElement;
  input: TaskRequestInput; git: GitCommitPanel;
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
    view.list.replaceChildren();
    const changes = Array.isArray(payload.changes) ? payload.changes : [];
    if (!changes.length) {
      const empty = document.createElement("p");
      empty.className = "product-empty";
      empty.textContent = "本轮任务还没有修改文件。";
      view.list.append(empty);
    }
    for (const [index, value] of [...changes].reverse().entries()) {
      view.list.append(createChangeEntry(value as Change, changes.length - index,
        (id, action) => reviewChange(view, id, action)));
    }
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
  await drawChanges({ dialog, body, list, input, git });
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
