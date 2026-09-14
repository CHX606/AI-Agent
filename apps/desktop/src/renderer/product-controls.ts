import type { TaskRequestInput } from "../shared/contracts.js";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "./product-controls.css";
import { mountExecutionSettings } from "./execution-settings.js";

const settingsIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>`;

interface SelectElement extends HTMLElement {
  disabled: boolean;
  value: string | string[];
}

export function permissionMode(): "read_only" | "confirm" | "edit" {
  const value = document.querySelector<SelectElement>("#permission-mode")?.value;
  return value === "read_only" || value === "edit" ? value : "confirm";
}

export function mountProductControls(current: () => TaskRequestInput,
  diagnosticCurrent: () => { gatewayUrl: string; taskId?: string }): void {
  // 和多 Agent 开关放在一起：这些选项都只影响下一次发送的任务。
  const permission = document.createElement("div");
  permission.className = "permission-control";
  permission.innerHTML = `<wa-select id="permission-mode" label="本轮工具权限" value="confirm" size="s" appearance="filled-outlined" placement="top">
      <svg slot="start" class="permission-shield" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 3v6c0 4-5 7-8 9-3-2-8-5-8-9V6Z"/><path d="m9 12 2 2 4-4"/></svg>
      <wa-option value="confirm">逐次确认</wa-option>
      <wa-option value="read_only">只读模式</wa-option>
      <wa-option value="edit">允许修改</wa-option>
      <svg slot="expand-icon" class="composer-select-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
    </wa-select>`;
  const context = document.querySelector(".composer-context");
  context?.insertBefore(permission, context.querySelector(".composer-tip"));
  const select = permission.querySelector<SelectElement>("wa-select")!;
  const describePermission = () => {
    permission.title = select.value === "read_only" ? "只读：不修改文件，也不执行代码。"
      : select.value === "edit" ? "允许修改文件和隔离验证；其他高风险操作仍需确认。"
        : "文件修改和代码执行前，逐次向你确认。";
  };
  select.addEventListener("change", describePermission);
  describePermission();

  const settingsButton = document.createElement("button");
  settingsButton.type = "button";
  settingsButton.id = "model-settings";
  settingsButton.className = "sidebar-model-settings";
  settingsButton.innerHTML = `${settingsIcon}<span>模型设置</span><svg class="settings-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;
  document.querySelector("#settings-panel")?.before(settingsButton);
  // 侧栏折叠成图标时，仍然保留设置入口。
  const compactSettings = document.createElement("button");
  compactSettings.type = "button";
  compactSettings.className = "rail-item rail-model-settings";
  compactSettings.title = "模型设置";
  compactSettings.setAttribute("aria-label", "模型设置");
  compactSettings.innerHTML = settingsIcon;
  document.querySelector("#theme-toggle")?.before(compactSettings);

  const reviewButton = document.createElement("button");
  reviewButton.type = "button";
  reviewButton.id = "review-changes";
  reviewButton.className = "review-changes-button";
  reviewButton.textContent = "审阅改动";
  document.querySelector("#changed-files")?.closest(".inspector-section")
    ?.querySelector(".inspector-heading")?.append(reviewButton);

  const modal = document.createElement("dialog");
  modal.className = "product-dialog";
  modal.setAttribute("aria-labelledby", "product-dialog-title");
  document.body.append(modal);

  function open(kind: "model" | "review" | "diagnostics", title: string, description: string): HTMLElement {
    modal.replaceChildren();
    modal.dataset.view = kind;
    const header = document.createElement("header");
    header.className = "product-dialog-header";
    const copy = document.createElement("div");
    const heading = document.createElement("h2");
    heading.id = "product-dialog-title";
    heading.textContent = title;
    const subtitle = document.createElement("p");
    subtitle.textContent = description;
    copy.append(heading, subtitle);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "icon-button";
    close.setAttribute("aria-label", "关闭弹窗");
    close.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>`;
    close.onclick = () => modal.close();
    header.append(copy, close);
    const body = document.createElement("div");
    body.className = "product-dialog-body";
    body.setAttribute("aria-busy", "true");
    const loading = document.createElement("p");
    loading.className = "product-loading";
    loading.textContent = "正在读取…";
    body.append(loading);
    modal.append(header, body);
    if (!modal.open) modal.showModal();
    return body;
  }

  const active = (body: HTMLElement) => modal.open && modal.contains(body);
  const diagnosticsButton = document.createElement("button");
  diagnosticsButton.type = "button";
  diagnosticsButton.id = "diagnostics-settings";
  diagnosticsButton.className = "sidebar-model-settings";
  diagnosticsButton.innerHTML = `${settingsIcon}<span>日志与诊断</span>`;
  settingsButton.after(diagnosticsButton);
  const compactDiagnostics = document.createElement("button");
  compactDiagnostics.type = "button";
  compactDiagnostics.className = "rail-item rail-model-settings";
  compactDiagnostics.title = "日志与诊断";
  compactDiagnostics.setAttribute("aria-label", "日志与诊断");
  compactDiagnostics.innerHTML = settingsIcon;
  compactSettings.after(compactDiagnostics);
  const showDiagnostics = async () => {
    const body = open("diagnostics", "日志与诊断", "诊断包只保存在你选择的位置，不会自动上传；不包含对话全文、用户文件和密钥。");
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
        const value = await window.bitAgent.diagnosticStatus(diagnosticCurrent());
        if (!active(body)) return;
        ready(body);
        status.textContent = `日志目录：${String(value.directory ?? "")}。${value.available ? "日志正常。" : "日志写入受限。"}${value.unavailable ? "运行服务不可用，仍可导出已有日志。" : ""}`;
        tasks.replaceChildren();
        const labels: Record<string, string> = { model: "正在等待模型", tool: "正在执行工具",
          approval: "正在等待确认或审批", user_input: "正在等待你的回答", paused: "已暂停",
          execution_resource: "正在等待执行资源", processing: "正在处理或保存状态", finished: "任务已结束" };
        for (const item of Array.isArray(value.tasks) ? value.tasks : []) {
          const row = document.createElement("p");
          const since = item.phase === "finished" ? NaN : Date.parse(String(item.phase_since ?? ""));
          row.textContent = `${String(item.task_id).slice(0, 12)}：${labels[String(item.phase)] ?? "状态未知"}${Number.isFinite(since) ? `（${Math.max(0, Math.floor((Date.now() - since) / 1000))} 秒）` : ""}`;
          tasks.append(row);
        }
        if (!tasks.childNodes.length) tasks.textContent = "暂无可用任务状态。";
      } catch (error) { feedback(body, error); }
    };
    refresh.onclick = () => { void update(); };
    exportButton.onclick = async () => {
      exportButton.disabled = true;
      try {
        const result = await window.bitAgent.exportDiagnostics(diagnosticCurrent());
        if (!result.cancelled) feedback(body, `诊断包已保存：${String(result.path)}`, true);
      } catch (error) { feedback(body, error); }
      finally { exportButton.disabled = false; }
    };
    await update();
    const timer = setInterval(() => { if (active(body)) void update(); else clearInterval(timer); }, 5000);
  };
  diagnosticsButton.onclick = () => { void showDiagnostics(); };
  compactDiagnostics.onclick = () => { void showDiagnostics(); };
  function ready(body: HTMLElement): void {
    body.querySelector(".product-loading")?.remove();
    body.setAttribute("aria-busy", "false");
  }
  function feedback(body: HTMLElement, value: unknown, success = false): void {
    if (!active(body)) return;
    ready(body);
    let message = body.querySelector<HTMLParagraphElement>(".product-feedback");
    if (!message) {
      message = document.createElement("p");
      message.className = "product-feedback";
      body.append(message);
    }
    message.dataset.kind = success ? "success" : "error";
    message.setAttribute("role", success ? "status" : "alert");
    message.textContent = value instanceof Error ? value.message : String(value);
  }

  reviewButton.addEventListener("click", async () => {
    const body = open("review", "审阅改动", "查看本轮任务写入的文件，决定保留或撤销。");
    const note = document.createElement("div");
    note.className = "review-explanation";
    note.innerHTML = `<p>改动已经写入文件。保留不会重复写入；撤销仅在任务结束后可用。</p>
      <details><summary>撤销时如何保护文件？</summary><p>如果文件后来被编辑，系统会拒绝覆盖。多次修改同一文件时，请从最新一次往前撤销。</p></details>`;
    body.append(note);
    const list = document.createElement("div");
    list.className = "change-list";
    body.append(list);
    let input: TaskRequestInput;
    try { input = current(); }
    catch {
      ready(body);
      list.className = "product-empty";
      list.textContent = "选择一段会话后，就能查看该任务的文件改动。";
      return;
    }
    async function draw(): Promise<void> {
      try {
        const payload = await window.bitAgent.getChanges(input);
        if (!active(body)) return;
        ready(body);
        list.replaceChildren();
        const changes = Array.isArray(payload.changes) ? payload.changes : [];
        if (!changes.length) {
          const empty = document.createElement("p");
          empty.className = "product-empty";
          empty.textContent = "本轮任务还没有修改文件。";
          list.append(empty);
        }
        for (const [index, value] of [...changes].reverse().entries()) {
          const change = value as { id: string; status: string; files: { path: string; diff: string; truncated: boolean }[] };
          const article = document.createElement("article");
          article.className = "change-entry";
          const toolbar = document.createElement("div");
          toolbar.className = "change-entry-toolbar";
          const title = document.createElement("strong");
          title.textContent = `第 ${changes.length - index} 次改动`;
          const status = document.createElement("span");
          status.className = "change-status";
          status.dataset.status = change.status;
          status.textContent = ({ undone: "已撤销", pending: "处理中", accepted: "已保留", applied: "待审阅" } as Record<string, string>)[change.status] ?? change.status;
          const actions = document.createElement("div");
          actions.className = "change-actions";
          for (const [action, label] of [["accept", "保留改动"], ["undo", "撤销这次改动"]] as const) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = action === "undo" ? "button-secondary change-undo" : "button-secondary";
            button.textContent = label;
            button.disabled = change.status === "undone" || change.status === "pending";
            button.onclick = async () => {
              if (action === "undo" && !window.confirm("撤销本次改动？如果文件后来被编辑，系统会拒绝覆盖。")) return;
              const buttons = [...list.querySelectorAll<HTMLButtonElement>("button")];
              const disabled = buttons.map((item) => item.disabled);
              buttons.forEach((item) => { item.disabled = true; });
              try {
                await window.bitAgent.reviewChange({ ...input, changeId: change.id, action });
                await draw();
              } catch (error) { feedback(body, error); }
              finally { buttons.forEach((item, position) => { item.disabled = disabled[position] ?? false; }); }
            };
            actions.append(button);
          }
          toolbar.append(title, status, actions);
          article.append(toolbar);
          for (const file of change.files) {
            const details = document.createElement("details");
            details.className = "change-file";
            details.open = true;
            const summary = document.createElement("summary");
            summary.textContent = file.path;
            summary.title = file.path;
            const pre = document.createElement("pre");
            pre.className = "product-diff";
            pre.tabIndex = 0;
            pre.setAttribute("aria-label", `${file.path} 的文件差异`);
            // 文件内容只当作文字显示，不能让其中的 HTML 变成页面代码。
            for (const line of file.diff.split("\n")) {
              const span = document.createElement("span");
              span.className = "diff-line";
              if (line.startsWith("@@")) span.dataset.kind = "hunk";
              else if (line.startsWith("+") && !line.startsWith("+++")) span.dataset.kind = "add";
              else if (line.startsWith("-") && !line.startsWith("---")) span.dataset.kind = "remove";
              span.textContent = `${line}\n`;
              pre.append(span);
            }
            details.append(summary, pre);
            if (file.truncated) {
              const truncated = document.createElement("p");
              truncated.className = "diff-truncated";
              truncated.textContent = "内容较长，这里只显示部分差异。";
              details.append(truncated);
            }
            article.append(details);
          }
          list.append(article);
        }
      } catch (error) { feedback(body, error); }
    }
    await draw();
  });

  async function showModelSettings(): Promise<void> {
    const body = open("model", "模型设置", "连接你使用的模型服务，保存后从下一次任务开始生效。");
    try {
      const settings = await window.bitAgent.getModelSettings();
      if (!active(body)) return;
      ready(body);
      const form = document.createElement("form");
      form.className = "model-settings-form";
      form.innerHTML = `<div class="model-field"><label for="model-base-url">接口地址</label>
          <input id="model-base-url" name="baseUrl" type="url" required spellcheck="false" placeholder="https://api.example.com/v1">
          <p>填写模型服务提供的 API 地址，而不是聊天网页地址。</p></div>
        <div class="model-field"><label for="model-name">模型名称</label>
          <input id="model-name" name="model" required spellcheck="false" placeholder="填写服务商提供的模型名称"></div>
        <div class="model-field"><label for="model-api-key">API Key <span class="model-key-state"></span></label>
          <input id="model-api-key" name="apiKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="留空保留现有密钥">
          <p>密钥由 Windows 加密保存，不会回传到这个页面。</p></div>
        <div class="model-settings-footer"><span>只保存设置，不会发起模型请求。</span>
          <button type="button" class="button-secondary" data-close>取消</button>
          <button type="submit" class="button-primary">保存设置</button></div>`;
      (form.elements.namedItem("baseUrl") as HTMLInputElement).value = String(settings.baseUrl ?? "");
      (form.elements.namedItem("model") as HTMLInputElement).value = String(settings.model ?? "");
      form.querySelector(".model-key-state")!.textContent = settings.configured ? "已配置" : "未配置";
      form.querySelector("[data-close]")!.addEventListener("click", () => modal.close());
      form.onsubmit = async (event) => {
        event.preventDefault();
        const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        submit.disabled = true;
        submit.textContent = "正在保存…";
        try {
          const values = Object.fromEntries(new FormData(form).entries());
          await window.bitAgent.saveModelSettings(values);
          (form.elements.namedItem("apiKey") as HTMLInputElement).value = "";
          form.querySelector(".model-key-state")!.textContent = "已配置";
          feedback(body, "设置已保存，将用于下一次任务。模型连接尚未验证。", true);
        } catch (error) { feedback(body, error); }
        finally { submit.disabled = false; submit.textContent = "保存设置"; }
      };
      body.append(form);
    } catch (error) { feedback(body, error); }
  }
  settingsButton.addEventListener("click", () => { void showModelSettings(); });
  compactSettings.addEventListener("click", () => { void showModelSettings(); });
  mountExecutionSettings();
}
