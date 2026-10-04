import type { MultiAgentMode } from "../shared/contracts";
import { type ChoiceMenu, icons } from "./choice-menu";
import { renderMarkdown } from "./markdown";
import "./session-view.css";

const modeControl = document.querySelector<ChoiceMenu>("#agent-mode")!;
modeControl.configure({
  heading: "要让 Bit Agent 分工调查吗？",
  label: "多 Agent 模式",
  prefix: "多 Agent",
  value: "auto",
  choices: [
    { value: "auto", label: "智能", icon: icons.sparkle, description: "需要时才派子 Agent 并行调查；普通问题直接回答" },
    { value: "on", label: "开启", icon: icons.people, description: "先考虑分工，把适合独立调查的部分交给子 Agent" },
    { value: "off", label: "关闭", icon: icons.person, description: "由主 Agent 自己完成；独立验收仍会进行" },
  ],
});
const previousTurns = document.querySelector<HTMLElement>("#previous-turns")!;
let mode: MultiAgentMode = "auto";

export function getAgentMode(): MultiAgentMode { return mode; }

export function setAgentMode(value: unknown): void {
  mode = value === "on" || value === "off" ? value : "auto";
  modeControl.value = mode;
}

export function setModeDisabled(disabled: boolean): void {
  modeControl.disabled = disabled;
}

export function onAgentModeChange(listener: (mode: MultiAgentMode) => void): void {
  modeControl.addEventListener("change", () => {
    setAgentMode(modeControl.value);
    listener(mode);
  });
}

export function clearPreviousTurns(): void { previousTurns.replaceChildren(); }

const statusNotes: Record<string, string> = {
  FAILED: "这一轮未完成", CANCELLED: "这一轮已停止", PARTIAL: "这一轮部分完成",
};

export interface PreviousTurnOptions {
  /** 本次打开期间已经画好的过程（按任务 ID），直接放回旧轮次，不必重新载入。 */
  processes?: Map<string, Node[]>;
  /** 点“查看执行过程”时调用：把那一轮的记录回放进给定的列表。 */
  expand?(taskId: string, stream: HTMLOListElement, answer: string): Promise<void>;
}

/**
 * 旧轮次和当前轮次用同一种样式：› 你的要求，● 最终回答。
 * 本次打开期间做过的轮次保留完整过程；更早的轮次只显示回答，可以点开回放过程。
 */
export function renderPreviousTurns(
  payload: Record<string, unknown>, currentTaskId: string | null, options: PreviousTurnOptions = {},
): void {
  clearPreviousTurns();
  if (!Array.isArray(payload.turns)) return;
  for (const raw of payload.turns) {
    if (!raw || typeof raw !== "object") continue;
    const turn = raw as Record<string, unknown>;
    if (turn.task_id === currentTaskId) continue;
    const taskId = typeof turn.task_id === "string" ? turn.task_id : "";
    const section = document.createElement("section");
    section.className = "turn saved-turn";
    section.dataset.taskId = taskId;
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
    section.append(user);
    if (Array.isArray(turn.intent_updates)) {
      for (const rawUpdate of turn.intent_updates) {
        if (!rawUpdate || typeof rawUpdate !== "object") continue;
        const update = rawUpdate as Record<string, unknown>;
        if (typeof update.text !== "string") continue;
        const note = document.createElement("p");
        note.className = "turn-update";
        note.textContent = (update.kind === "replace" ? "修改目标：" : "补充要求：") + update.text;
        section.append(note);
      }
    }
    const stream = document.createElement("ol");
    stream.className = "stream";
    const answer = typeof turn.final_answer === "string" ? turn.final_answer : "";
    const kept = options.processes?.get(taskId);
    if (kept?.length) {
      stream.append(...kept);
      section.append(stream);
      previousTurns.append(section);
      continue;
    }
    if (taskId && options.expand) {
      const expand = document.createElement("button");
      expand.type = "button";
      expand.className = "turn-expand";
      expand.textContent = "查看执行过程";
      expand.addEventListener("click", async () => {
        expand.disabled = true;
        expand.textContent = "正在载入…";
        try {
          await options.expand!(taskId, stream, answer);
          expand.remove();
        } catch {
          expand.disabled = false;
          expand.textContent = "载入失败，点此重试";
        }
      });
      section.append(expand);
    }
    const status = String(turn.status ?? "");
    if (statusNotes[status]) {
      const note = document.createElement("li");
      note.className = "stream-item stream-note";
      note.dataset.tone = status === "FAILED" ? "error" : "neutral";
      note.innerHTML = `<span class="stream-note-mark" aria-hidden="true">※</span><span></span>`;
      note.lastElementChild!.textContent = statusNotes[status]!;
      stream.append(note);
    }
    if (answer) {
      const item = document.createElement("li");
      item.className = "stream-item stream-text";
      const mark = document.createElement("span");
      mark.className = "stream-bullet";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = "●";
      const response = document.createElement("div");
      response.className = "markdown-body";
      renderMarkdown(response, answer);
      item.append(mark, response);
      stream.append(item);
    }
    section.append(stream);
    previousTurns.append(section);
  }
}
