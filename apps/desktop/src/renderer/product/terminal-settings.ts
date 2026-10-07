import { readTerminalPosition, saveTerminalPosition } from "../terminal/terminal-position.js";
import type { ProductDialog } from "./dialog.js";

export function showTerminalSettings(dialog: ProductDialog): void {
  const body = dialog.open("terminal", "终端设置", "选择内置终端的显示位置，调整后立即生效。");
  const form = document.createElement("div");
  form.className = "terminal-settings-form";
  form.innerHTML = `<label for="terminal-position">显示位置</label>
    <select id="terminal-position" name="terminalPosition">
      <option value="right">右侧</option><option value="bottom">底部</option>
    </select><p>默认在右侧显示。切换位置会保留当前终端会话。</p>`;
  const select = form.querySelector<HTMLSelectElement>("select")!;
  select.value = readTerminalPosition();
  select.addEventListener("change", () => {
    try {
      saveTerminalPosition(select.value === "bottom" ? "bottom" : "right");
      body.querySelector(".product-feedback")?.remove();
    } catch (error) { select.value = readTerminalPosition(); dialog.feedback(body, error); }
  });
  body.append(form);
  dialog.ready(body);
}
