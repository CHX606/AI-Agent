import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/translations/zh-cn.js";
import { createExecutionDialog } from "./product/execution-dialog.js";
import { ExecutionSettingsController } from "./product/execution-controller.js";
import "./execution-settings.css";

export function mountExecutionSettings(): void {
  const icon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>`;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.id = "execution-settings";
  trigger.className = "sidebar-model-settings";
  trigger.innerHTML = `${icon}<span>执行设置</span>`;
  document.querySelector("#model-settings")?.after(trigger);
  new ExecutionSettingsController(createExecutionDialog()).bind(trigger);
}
