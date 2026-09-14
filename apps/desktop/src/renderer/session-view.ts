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

/** 旧轮次展示在上方，当前轮次继续使用原来的执行记录和结果面板。 */
export function renderPreviousTurns(payload: Record<string, unknown>, currentTaskId: string | null): void {
  clearPreviousTurns();
  if (!Array.isArray(payload.turns)) return;
  for (const raw of payload.turns) {
    if (!raw || typeof raw !== "object") continue;
    const turn = raw as Record<string, unknown>;
    if (turn.task_id === currentTaskId) continue;
    const section = document.createElement("section");
    section.className = "saved-turn";
    const user = document.createElement("strong");
    user.textContent = "你";
    const question = document.createElement("p");
    question.className = "saved-question";
    question.textContent = typeof turn.objective === "string" ? turn.objective : "";
    const agent = document.createElement("strong");
    agent.textContent = `Bit Agent · ${String(turn.status ?? "")}`;
    const response = document.createElement("div");
    response.className = "markdown-body";
    renderMarkdown(response, typeof turn.final_answer === "string" && turn.final_answer ? turn.final_answer : "该轮没有最终回答。");
    section.append(user, question);
    if (Array.isArray(turn.intent_updates)) {
      for (const rawUpdate of turn.intent_updates) {
        if (!rawUpdate || typeof rawUpdate !== "object") continue;
        const update = rawUpdate as Record<string, unknown>;
        if (typeof update.text !== "string") continue;
        const note = document.createElement("p");
        note.className = "saved-question";
        note.textContent = (update.kind === "replace" ? "修改目标：" : "补充要求：") + update.text;
        section.append(note);
      }
    }
    section.append(agent, response);
    previousTurns.append(section);
  }
}
