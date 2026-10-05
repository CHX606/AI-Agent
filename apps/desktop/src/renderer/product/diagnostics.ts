import type { ProductDialog } from "./dialog.js";

type DiagnosticCurrent = () => { gatewayUrl: string; taskId?: string };
const labels: Record<string, string> = { model: "正在等待模型", tool: "正在执行工具",
  approval: "正在等待确认或审批", user_input: "正在等待你的回答", paused: "已暂停",
  execution_resource: "正在等待执行资源", processing: "正在处理或保存状态", finished: "任务已结束" };

function paintTasks(tasks: HTMLElement, value: Record<string, unknown>): void {
  tasks.replaceChildren();
  for (const item of Array.isArray(value.tasks) ? value.tasks : []) {
    const row = document.createElement("p");
    const since = item.phase === "finished" ? NaN : Date.parse(String(item.phase_since ?? ""));
    row.textContent = `${String(item.task_id).slice(0, 12)}：${labels[String(item.phase)] ?? "状态未知"}${Number.isFinite(since) ? `（${Math.max(0, Math.floor((Date.now() - since) / 1000))} 秒）` : ""}`;
    tasks.append(row);
  }
  if (!tasks.childNodes.length) tasks.textContent = "暂无可用任务状态。";
}

async function exportPackage(button: HTMLButtonElement, dialog: ProductDialog,
  body: HTMLElement, current: DiagnosticCurrent): Promise<void> {
  button.disabled = true;
  try {
    const result = await window.bitAgent.exportDiagnostics(current());
    if (!result.cancelled) dialog.feedback(body, `诊断包已保存：${String(result.path)}`, true);
  } catch (error) { dialog.feedback(body, error); }
  finally { button.disabled = false; }
}

export async function showDiagnostics(dialog: ProductDialog, current: DiagnosticCurrent): Promise<void> {
  const body = dialog.open("diagnostics", "日志与诊断", "诊断包只保存在你选择的位置，不会自动上传；不包含对话全文、用户文件和密钥。");
  const status = document.createElement("p");
  status.className = "diagnostic-location";
  const tasks = document.createElement("div");
  tasks.setAttribute("aria-live", "polite");
  const actions = document.createElement("div");
  actions.className = "diagnostic-actions";
  const refresh = document.createElement("button");
  refresh.textContent = "刷新状态";
  refresh.className = "button-secondary";
  const exportButton = document.createElement("button");
  exportButton.id = "export-diagnostics";
  exportButton.className = "button-primary";
  exportButton.textContent = "导出脱敏诊断包";
  actions.append(refresh, exportButton);
  body.append(status, tasks, actions);
  const update = async () => {
    try {
      const value = await window.bitAgent.diagnosticStatus(current());
      if (!dialog.active(body)) return;
      dialog.ready(body);
      status.textContent = `日志目录：${String(value.directory ?? "")}。${value.available ? "日志正常。" : "日志写入受限。"}${value.unavailable ? "运行服务不可用，仍可导出已有日志。" : ""}`;
      paintTasks(tasks, value);
    } catch (error) { dialog.feedback(body, error); }
  };
  refresh.onclick = () => { void update(); };
  exportButton.onclick = () => exportPackage(exportButton, dialog, body, current);
  await update();
  const timer = setInterval(() => { if (dialog.active(body)) void update(); else clearInterval(timer); }, 5000);
}
