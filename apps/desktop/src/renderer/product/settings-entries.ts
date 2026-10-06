import { renderMcpPanel } from "../mcp-panel.js";
import { showDiagnostics } from "./diagnostics.js";
import type { ProductDialog } from "./dialog.js";
import { showMemories } from "./memory.js";
import { showModelSettings } from "./model.js";

// 每个入口一个图标：模型（芯片）、诊断（心电线）；执行设置的图标在 execution-settings.ts。
const modelIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/></svg>`;
const diagnosticsIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2-5 4 10 2-5h6"/></svg>`;
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
  const model = settingButton("model-settings", `${modelIcon}<span>模型设置</span><svg class="settings-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`);
  document.querySelector("#settings-panel")?.before(model);
  const diagnostics = settingButton("diagnostics-settings", `${diagnosticsIcon}<span>日志与诊断</span>`);
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
