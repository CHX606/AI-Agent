/** 终端停靠位置：设置与面板共用同一份本机偏好。 */
export type TerminalPosition = "right" | "bottom";
const POSITION_KEY = "bit-agent.terminal-position.v1";
export const POSITION_CHANGED = "bit-agent:terminal-position";

export function readTerminalPosition(): TerminalPosition {
  return localStorage.getItem(POSITION_KEY) === "bottom" ? "bottom" : "right";
}

export function saveTerminalPosition(position: TerminalPosition): void {
  if (position !== "right" && position !== "bottom") throw new Error("终端位置无效");
  localStorage.setItem(POSITION_KEY, position);
  window.dispatchEvent(new Event(POSITION_CHANGED));
}
