import { renderMcpPanel } from "../mcp-panel.js";
import { showDiagnostics } from "./diagnostics.js";
import type { ProductDialog } from "./dialog.js";
import { showMemories } from "./memory.js";
import { showModelSettings } from "./model.js";

const settingsIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>`;
const memoryIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v16l-6-4-6 4Z"/></svg>`;
const toolsIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/></svg>`;

function settingButton(id: string, html: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.id = id;
  button.className = "sidebar-model-settings";
  button.innerHTML = html;
  return button;
}

async function showTools(dialog: ProductDialog): Promise<void> {
  const body = dialog.open("mcp", "外部工具", "通过 MCP 给 Agent 增加工具，只对主 Agent 开放。");
  try { await renderMcpPanel(body); }
  catch (error) { dialog.feedback(body, error); }
}

export function mountSettingsEntries(dialog: ProductDialog,
  diagnosticCurrent: () => { gatewayUrl: string; taskId?: string },
  memoryCurrent: () => { gatewayUrl: string; workspaceRoot: string }): void {
  const model = settingButton("model-settings", `${settingsIcon}<span>模型设置</span><svg class="settings-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`);
  document.querySelector("#settings-panel")?.before(model);
  const diagnostics = settingButton("diagnostics-settings", `${settingsIcon}<span>日志与诊断</span>`);
  model.after(diagnostics);
  const memory = settingButton("memory-settings", `${memoryIcon}<span>长期记忆</span>`);
  diagnostics.after(memory);
  const tools = settingButton("mcp-settings", `${toolsIcon}<span>外部工具</span>`);
  memory.after(tools);
  model.addEventListener("click", () => { void showModelSettings(dialog); });
  diagnostics.onclick = () => { void showDiagnostics(dialog, diagnosticCurrent); };
  memory.onclick = () => { void showMemories(dialog, memoryCurrent); };
  tools.onclick = () => { void showTools(dialog); };
}
