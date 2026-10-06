import { renderMessageImages } from "./attachments/message-images";
import { registerMarkdown, replyMarkdown } from "./copy-button";
import { replyActions, userActions } from "./message-actions";
import { object } from "./dom";
import { renderMarkdown } from "./markdown";

const previousTurns = document.querySelector<HTMLElement>("#previous-turns")!;
const statusNotes: Record<string, string> = {
  FAILED: "这一轮未完成", CANCELLED: "已停止", PARTIAL: "这一轮部分完成",
};

export interface PreviousTurnOptions {
  processes?: Map<string, Node[]>;
  expand?(taskId: string, stream: HTMLOListElement, answer: string): Promise<void>;
}

export function clearPreviousTurns(): void { previousTurns.replaceChildren(); }

function userMessage(turn: Record<string, unknown>): HTMLElement {
  const user = document.createElement("div");
  user.className = "turn-user";
  const prompt = document.createElement("span");
  prompt.className = "turn-prompt";
  prompt.setAttribute("aria-hidden", "true");
  prompt.textContent = "›";
  const question = document.createElement("p");
  question.className = "turn-user-text saved-question";
  question.textContent = typeof turn.objective === "string" ? turn.objective : "";
  user.append(prompt, question);
  renderMessageImages(user, turn.images);
  return user;
}

function keptImageUpdate(kept: Node[], update: Record<string, unknown>): number {
  const sources = Array.isArray(update.images)
    ? update.images.map(object).map(image => image?.data_url).filter(source => typeof source === "string") : [];
  if (!sources.length) return -1;
  const text = typeof update.text === "string" ? update.text : "";
  return kept.findIndex(node => {
    if (!(node instanceof HTMLElement) || !node.classList.contains("stream-user")) return false;
    const message = node.querySelector("p")?.textContent;
    const previews = [...node.querySelectorAll(".message-image img")].map(image => image.getAttribute("src"));
    return (message === text || message === `不批准：${text}`) && previews.length === sources.length
      && previews.every((source, index) => source === sources[index]);
  });
}

function appendUpdates(section: HTMLElement, value: unknown, kept: Node[] = []): void {
  if (!Array.isArray(value)) return;
  const remaining = [...kept];
  for (const raw of value) {
    const update = object(raw);
    if (!update || (typeof update.text !== "string" && !Array.isArray(update.images))) continue;
    const cached = keptImageUpdate(remaining, update);
    if (cached !== -1) { remaining.splice(cached, 1); continue; }
    const note = document.createElement("div");
    note.className = "turn-update";
    note.textContent = (update.kind === "replace" ? "修改目标：" : "补充要求：") + String(update.text ?? "");
    renderMessageImages(note, update.images);
    section.append(note);
  }
}

function appendExpansion(section: HTMLElement, stream: HTMLOListElement, taskId: string,
  answer: string, options: PreviousTurnOptions): void {
  if (!taskId || !options.expand) return;
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "turn-expand";
  expand.textContent = "查看执行过程";
  expand.addEventListener("click", async () => {
    expand.disabled = true;
    expand.textContent = "正在载入…";
    try { await options.expand!(taskId, stream, answer); expand.remove(); }
    catch { expand.disabled = false; expand.textContent = "载入失败，点此重试"; }
  });
  section.append(expand);
}

function appendAnswer(stream: HTMLOListElement, answer: string): void {
  if (!answer) return;
  const item = document.createElement("li");
  item.className = "stream-item stream-text";
  const response = document.createElement("div");
  response.className = "markdown-body";
  renderMarkdown(response, answer);
  item.append(response);
  registerMarkdown(item, () => answer);
  stream.append(item);
}

function appendStatus(stream: HTMLOListElement, value: unknown): void {
  const status = String(value ?? "");
  if (!statusNotes[status]) return;
  const note = document.createElement("li");
  note.className = "stream-item stream-note";
  note.dataset.tone = status === "FAILED" ? "error" : "neutral";
  note.innerHTML = '<span class="stream-note-mark" aria-hidden="true">※</span><span></span>';
  note.lastElementChild!.textContent = statusNotes[status]!;
  stream.append(note);
}

function renderTurn(turn: Record<string, unknown>, options: PreviousTurnOptions): void {
  const taskId = typeof turn.task_id === "string" ? turn.task_id : "";
  const section = document.createElement("section");
  section.className = "turn saved-turn";
  section.dataset.taskId = taskId;
  const objective = typeof turn.objective === "string" ? turn.objective : "";
  section.append(userMessage(turn));
  if (objective) section.append(userActions(() => objective));
  const kept = options.processes?.get(taskId);
  appendUpdates(section, turn.intent_updates, kept);
  const stream = document.createElement("ol");
  stream.className = "stream";
  const answer = typeof turn.final_answer === "string" ? turn.final_answer : "";
  if (kept?.length) stream.append(...kept);
  else {
    appendExpansion(section, stream, taskId, answer, options);
    appendStatus(stream, turn.status);
    appendAnswer(stream, answer);
  }
  section.append(stream);
  // 点开“查看执行过程”后文字会变，复制时按当时显示的内容读取。
  if (replyMarkdown(stream) || answer) section.append(replyActions(stream));
  previousTurns.append(section);
}

export function renderPreviousTurns(payload: Record<string, unknown>, currentTaskId: string | null,
  options: PreviousTurnOptions = {}): void {
  clearPreviousTurns();
  if (!Array.isArray(payload.turns)) return;
  for (const raw of payload.turns) {
    const turn = object(raw);
    if (turn && turn.task_id !== currentTaskId) renderTurn(turn, options);
  }
}
