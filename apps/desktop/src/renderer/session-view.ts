import type { MultiAgentMode } from "../shared/contracts";
import { type ChoiceMenu, icons } from "./choice-menu";
export { clearPreviousTurns, renderPreviousTurns, type PreviousTurnOptions } from "./previous-turns";
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
    { value: "off", label: "关闭", icon: icons.person, description: "由主 Agent 自己完成；独立验收按执行设置进行" },
  ],
});
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
