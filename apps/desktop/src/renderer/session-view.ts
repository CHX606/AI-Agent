import type { MultiAgentMode } from "../shared/contracts";
import { renderMarkdown } from "./markdown";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "./session-view.css";

interface SelectElement extends HTMLElement {
  disabled: boolean;
  value: string | string[];
}

const modeControl = document.querySelector<SelectElement>("#agent-mode")!;
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

/** 旧轮次和当前轮次用同一种样式：› 你的要求，● 最终回答。旧轮次只保留要求和回答，不重放过程。 */
export function renderPreviousTurns(payload: Record<string, unknown>, currentTaskId: string | null): void {
  clearPreviousTurns();
  if (!Array.isArray(payload.turns)) return;
  for (const raw of payload.turns) {
    if (!raw || typeof raw !== "object") continue;
    const turn = raw as Record<string, unknown>;
    if (turn.task_id === currentTaskId) continue;
    const section = document.createElement("section");
    section.className = "turn saved-turn";
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
    const status = String(turn.status ?? "");
    if (statusNotes[status]) {
      const note = document.createElement("li");
      note.className = "stream-item stream-note";
      note.dataset.tone = status === "FAILED" ? "error" : "neutral";
      note.innerHTML = `<span class="stream-note-mark" aria-hidden="true">※</span><span></span>`;
      note.lastElementChild!.textContent = statusNotes[status]!;
      stream.append(note);
    }
    const answer = typeof turn.final_answer === "string" ? turn.final_answer : "";
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
