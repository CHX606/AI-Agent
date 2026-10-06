import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/translations/zh-cn.js";
import { createExecutionDialog } from "./product/execution-dialog.js";
import { ExecutionSettingsController } from "./product/execution-controller.js";
import "./execution-settings.css";

export function mountExecutionSettings(): void {
  // 仪表盘：执行预算和验收方式。
  const icon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 17a8 8 0 1 1 15 0"/><path d="m12 13 3.5-4"/><circle cx="12" cy="13" r="1"/></svg>`;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.id = "execution-settings";
  trigger.className = "sidebar-model-settings";
  trigger.innerHTML = `${icon}<span>执行设置</span>`;
  document.querySelector("#model-settings")?.after(trigger);
  new ExecutionSettingsController(createExecutionDialog()).bind(trigger);
}
