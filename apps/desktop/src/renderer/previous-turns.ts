import { renderMessageAttachments } from "./attachments/message-attachments";
import { attachmentDetails, attachmentKey } from "./attachments/attachment-card";
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

export function clearPreviousTurns(): void { generation += 1; previousTurns.replaceChildren(); }

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
  renderMessageAttachments(user, turn.attachments);
  return user;
}

function keptUploadUpdate(kept: Node[], update: Record<string, unknown>): number {
  const sources = Array.isArray(update.images)
    ? update.images.map(object).map(image => image?.data_url).filter(source => typeof source === "string") : [];
  const attachments = Array.isArray(update.attachments) ? update.attachments : [];
  const keys = attachments.map(attachmentDetails).filter(details => details !== null).map(attachmentKey);
  if (!sources.length && !keys.length) return -1;
  const text = typeof update.text === "string" ? update.text : "";
  return kept.findIndex(node => {
    if (!(node instanceof HTMLElement) || !node.classList.contains("stream-user")) return false;
    const message = node.querySelector("p")?.textContent;
    const previews = [...node.querySelectorAll(".message-image img")].map(image => image.getAttribute("src"));
    const files = [...node.querySelectorAll<HTMLElement>(".message-attachments .attachment-card")].map(file => file.dataset.attachmentKey);
    return (message === text || message === `不批准：${text}`) && previews.length === sources.length
      && files.length === keys.length && files.every((key, index) => key === keys[index])
      && previews.every((source, index) => source === sources[index]);
  });
}

function appendUpdates(section: HTMLElement, value: unknown, kept: Node[] = []): void {
  if (!Array.isArray(value)) return;
  const remaining = [...kept];
  for (const raw of value) {
    const update = object(raw);
    if (!update || (typeof update.text !== "string" && !Array.isArray(update.images) && !Array.isArray(update.attachments))) continue;
    const cached = keptUploadUpdate(remaining, update);
    if (cached !== -1) { remaining.splice(cached, 1); continue; }
    const note = document.createElement("div");
    note.className = "turn-update";
    note.textContent = (update.kind === "replace" ? "修改目标：" : "补充要求：") + String(update.text ?? "");
    renderMessageImages(note, update.images);
    renderMessageAttachments(note, update.attachments);
    section.append(note);
  }
}

// 更早的轮次直接显示执行过程（和 Claude Code 一样，不用点开）：按顺序逐轮回放，回放好之前先显示回答。
// 切换对话后旧的回放队列作废。
let generation = 0;
let replaying: Promise<void> = Promise.resolve();

function replayProcess(stream: HTMLOListElement, taskId: string, answer: string, options: PreviousTurnOptions): void {
  if (!taskId || !options.expand) return;
  const current = generation;
  replaying = replaying.then(async () => {
    if (current !== generation) return;
    // 回放失败时保留原来的回答。
    await options.expand!(taskId, stream, answer).catch(() => undefined);
  });
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
    appendStatus(stream, turn.status);
    appendAnswer(stream, answer);
    replayProcess(stream, taskId, answer, options);
  }
  section.append(stream);
  // 回放执行过程后文字会变，复制时按当时显示的内容读取。
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
