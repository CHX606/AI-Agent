import type { TaskRequestInput } from "../shared/contracts.js";
import { parseModelList } from "../shared/model-list.js";
import { type ChoiceMenu, icons } from "./choice-menu.js";
import "./product-controls.css";
import { errorText } from "./dom.js";
import { mountExecutionSettings } from "./execution-settings.js";
import { createGitCommitPanel } from "./git-commit-panel.js";
import { createMemoryEntry } from "./memory-panel.js";
import { renderMcpPanel } from "./mcp-panel.js";

const settingsIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>`;
const memoryIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v16l-6-4-6 4Z"/></svg>`;
const toolsIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/></svg>`;

export function permissionMode(): "read_only" | "confirm" | "edit" {
  const value = document.querySelector<ChoiceMenu>("#permission-mode")?.value;
  return value === "read_only" || value === "edit" ? value : "confirm";
}

export function mountProductControls(current: () => TaskRequestInput,
  diagnosticCurrent: () => { gatewayUrl: string; taskId?: string },
  memoryCurrent: () => { gatewayUrl: string; workspaceRoot: string }): void {
  // 和多 Agent 开关放在一起：这些选项都只影响下一次发送的任务。
  const permission = document.createElement("div");
  permission.className = "permission-control";
  const menu = document.createElement("choice-menu");
  menu.id = "permission-mode";
  permission.append(menu);
  const context = document.querySelector(".composer-context");
  context?.insertBefore(permission, context.querySelector(".composer-tip"));
  // 权限从小到大排列，和 Codex 的“应如何批准”菜单一样；Shift+Tab 在输入框里循环切换。
  menu.configure({
    heading: "应如何批准 Bit Agent 的操作？",
    label: "本轮工具权限",
    value: "confirm",
    choices: [
      { value: "read_only", label: "只读模式", icon: icons.eye, description: "只阅读和搜索代码；不修改文件，也不运行检查" },
      { value: "confirm", label: "逐次确认", icon: icons.hand, description: "写文件和调用外部工具前先问你；隔离环境里的检查直接运行" },
      { value: "edit", label: "允许修改", icon: icons.pencil, tone: "caution", description: "直接修改工作区文件；删除、改验证配置和外部工具仍会询问" },
    ],
  });

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

  function open(kind: "model" | "review" | "diagnostics" | "memory" | "mcp", title: string, description: string): HTMLElement {
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

  const memoryButton = document.createElement("button");
  memoryButton.type = "button";
  memoryButton.id = "memory-settings";
  memoryButton.className = "sidebar-model-settings";
  memoryButton.innerHTML = `${memoryIcon}<span>长期记忆</span>`;
  diagnosticsButton.after(memoryButton);
  const compactMemory = document.createElement("button");
  compactMemory.type = "button";
  compactMemory.className = "rail-item rail-model-settings";
  compactMemory.title = "长期记忆";
  compactMemory.setAttribute("aria-label", "长期记忆");
  compactMemory.innerHTML = memoryIcon;
  compactDiagnostics.after(compactMemory);
  const showMemories = async () => {
    const body = open("memory", "长期记忆",
      "通过独立验收的任务会自动提炼经验，只保存在本机；新任务开始前按关键词召回本项目的相关经验。");
    const context = memoryCurrent();
    const toolbar = document.createElement("div");
    toolbar.className = "memory-toolbar";
    const scope = document.createElement("label");
    scope.className = "memory-scope";
    const showAll = document.createElement("input");
    showAll.type = "checkbox";
    showAll.id = "memory-show-all";
    // 没选工作区时只能看全部项目。
    showAll.checked = !context.workspaceRoot;
    showAll.disabled = !context.workspaceRoot;
    scope.append(showAll, document.createTextNode("显示所有项目"));
    const count = document.createElement("span");
    count.className = "memory-count";
    toolbar.append(scope, count);
    const list = document.createElement("div");
    list.className = "memory-list";
    list.setAttribute("aria-live", "polite");
    body.append(toolbar, list);

    const draw = async (): Promise<void> => {
      const all = showAll.checked;
      try {
        const result = await window.bitAgent.listMemories({ gatewayUrl: context.gatewayUrl,
          ...(all ? {} : { workspaceRoot: context.workspaceRoot }) });
        if (!active(body)) return;
        ready(body);
        list.replaceChildren();
        const memories = result.enabled ? result.memories : [];
        count.textContent = result.enabled ? `${memories.length} 条` : "";
        if (!result.enabled || !memories.length) {
          const empty = document.createElement("p");
          empty.className = "product-empty";
          empty.textContent = !result.enabled
            ? "长期记忆已关闭。去掉环境变量 BIT_AGENT_LONG_TERM_MEMORY=0 后重新启动应用即可开启。"
            : all ? "还没有记忆。完成一个通过独立验收的修改任务后，这里会出现提炼出的经验。"
              : "这个项目还没有记忆。可以勾选“显示所有项目”查看其他项目。";
          list.append(empty);
          return;
        }
        for (const memory of memories) {
          list.append(createMemoryEntry(memory, all, async (button) => {
            if (!window.confirm(`删除这条记忆？\n\n${memory.title}\n\n删除后，新任务不会再参考它。`)) return;
            button.disabled = true;
            try {
              await window.bitAgent.deleteMemory({ gatewayUrl: context.gatewayUrl, memoryId: memory.id });
              await draw();
            } catch (error) {
              button.disabled = false;
              feedback(body, error);
            }
          }));
        }
      } catch (error) { feedback(body, error); }
    };
    showAll.onchange = () => { void draw(); };
    await draw();
  };
  memoryButton.onclick = () => { void showMemories(); };
  compactMemory.onclick = () => { void showMemories(); };

  const toolsButton = document.createElement("button");
  toolsButton.type = "button";
  toolsButton.id = "mcp-settings";
  toolsButton.className = "sidebar-model-settings";
  toolsButton.innerHTML = `${toolsIcon}<span>外部工具</span>`;
  memoryButton.after(toolsButton);
  const compactTools = document.createElement("button");
  compactTools.type = "button";
  compactTools.className = "rail-item rail-model-settings";
  compactTools.title = "外部工具";
  compactTools.setAttribute("aria-label", "外部工具");
  compactTools.innerHTML = toolsIcon;
  compactMemory.after(compactTools);
  const showTools = async () => {
    const body = open("mcp", "外部工具", "通过 MCP 给 Agent 增加工具，只对主 Agent 开放。");
    try { await renderMcpPanel(body, (value, success) => feedback(body, value, success)); }
    catch (error) { feedback(body, error); }
  };
  toolsButton.onclick = () => { void showTools(); };
  compactTools.onclick = () => { void showTools(); };
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
    message.textContent = errorText(value);
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
    const git = createGitCommitPanel(input, (value, success) => feedback(body, value, success));
    list.before(git.element);
    void git.refresh();
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
          status.textContent = ({ undone: "已撤销", pending: "处理中", accepted: "已保留", applied: "待审阅", unreviewed: "待审阅" } as Record<string, string>)[change.status] ?? change.status;
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
                // 撤销后要提交的文件可能变了。
                if (action === "undo") await git.refresh();
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
        <div class="model-field"><label for="model-aux">辅助模型（可选）</label>
          <input id="model-aux" name="auxModel" spellcheck="false" maxlength="200" placeholder="留空则全部使用上面的模型">
          <p>同一接口地址下更便宜的模型，用于只读调查、历史摘要、经验提炼和提交信息；主任务和独立验收仍用主模型。</p></div>
        <div class="model-field"><label for="model-list">可切换的模型（可选）</label>
          <textarea id="model-list" name="models" rows="3" spellcheck="false" placeholder="每行一个，例如&#10;gpt-5.5&#10;gpt-5.5-mini"></textarea>
          <div class="model-list-actions"><button type="button" class="button-secondary" data-fetch-models>从服务获取</button>
            <span>在输入框右下角切换模型和思考程度；主模型始终可选。</span></div>
          <div class="model-fetch-result" hidden></div></div>
        <div class="model-field"><label for="model-api">接口类型</label>
          <select id="model-api" name="api">
            <option value="responses">Responses API（OpenAI 官方等）</option>
            <option value="chat_completions">Chat Completions（多数兼容服务、本地模型）</option>
          </select>
          <p>不确定时点“测试连接”，会自动检测并选中能用的那一种。</p></div>
        <div class="model-field"><label for="model-api-key">API Key <span class="model-key-state"></span></label>
          <input id="model-api-key" name="apiKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="留空保留现有密钥">
          <p>密钥由 Windows 加密保存，不会回传到这个页面。</p></div>
        <div class="model-field"><label for="model-input-price">价格（可选）</label>
          <div class="model-price-row">
            <input id="model-input-price" name="inputPrice" type="number" min="0" step="any" inputmode="decimal" placeholder="输入" aria-label="每百万输入 tokens 价格">
            <input id="model-output-price" name="outputPrice" type="number" min="0" step="any" inputmode="decimal" placeholder="输出" aria-label="每百万输出 tokens 价格">
            <select name="currency" aria-label="货币"><option value="¥">¥</option><option value="$">$</option></select>
          </div>
          <p>每百万 tokens 的价格，只用来在任务详情里估算费用；留空则只显示 tokens 数。</p></div>
        <div class="model-test-result" role="status" hidden></div>
        <div class="model-settings-footer"><span>保存不会发起模型请求，可以先测试连接。</span>
          <button type="button" class="button-secondary" data-test>测试连接</button>
          <button type="button" class="button-secondary" data-close>取消</button>
          <button type="submit" class="button-primary">保存设置</button></div>`;
      (form.elements.namedItem("baseUrl") as HTMLInputElement).value = String(settings.baseUrl ?? "");
      (form.elements.namedItem("model") as HTMLInputElement).value = String(settings.model ?? "");
      (form.elements.namedItem("auxModel") as HTMLInputElement).value = String(settings.auxModel ?? "");
      const modelList = form.elements.namedItem("models") as HTMLTextAreaElement;
      modelList.value = String(settings.models ?? "");
      const fetchButton = form.querySelector<HTMLButtonElement>("[data-fetch-models]")!;
      const fetched = form.querySelector<HTMLElement>(".model-fetch-result")!;
      // 从服务获取模型列表，勾选的加进“可切换的模型”，取消勾选的移出。
      fetchButton.addEventListener("click", async () => {
        if (!(form.elements.namedItem("baseUrl") as HTMLInputElement).reportValidity()) return;
        fetchButton.disabled = true;
        fetchButton.textContent = "正在获取…";
        try {
          const models = await window.bitAgent.listModels(Object.fromEntries(new FormData(form).entries()));
          if (!active(body)) return;
          const chosen = new Set(parseModelList(modelList.value));
          fetched.replaceChildren(...models.map((model) => {
            const label = document.createElement("label");
            const box = document.createElement("input");
            box.type = "checkbox";
            box.value = model;
            box.checked = chosen.has(model);
            box.addEventListener("change", () => {
              const current = parseModelList(modelList.value).filter((name) => name !== model);
              modelList.value = (box.checked ? [...current, model] : current).join("\n");
            });
            const name = document.createElement("span");
            name.textContent = model;
            name.title = model;
            label.append(box, name);
            return label;
          }));
          fetched.hidden = false;
        } catch (error) { feedback(body, error); }
        finally { fetchButton.disabled = false; fetchButton.textContent = "从服务获取"; }
      });
      (form.elements.namedItem("inputPrice") as HTMLInputElement).value = String(settings.inputPrice ?? "");
      (form.elements.namedItem("outputPrice") as HTMLInputElement).value = String(settings.outputPrice ?? "");
      (form.elements.namedItem("currency") as HTMLSelectElement).value = settings.currency === "$" ? "$" : "¥";
      const apiSelect = form.elements.namedItem("api") as HTMLSelectElement;
      apiSelect.value = settings.api === "chat_completions" ? "chat_completions" : "responses";
      form.querySelector(".model-key-state")!.textContent = settings.configured ? "已配置" : "未配置";
      form.querySelector("[data-close]")!.addEventListener("click", () => modal.close());
      const testButton = form.querySelector<HTMLButtonElement>("[data-test]")!;
      const testResult = form.querySelector<HTMLElement>(".model-test-result")!;
      const apiLabels: Record<string, string> = { responses: "Responses API", chat_completions: "Chat Completions" };
      // 测试之后又改了表单，旧的测试结论就不再适用。
      form.addEventListener("input", () => { delete testResult.dataset.ok; testResult.hidden = true; });
      testButton.addEventListener("click", async () => {
        if (!form.reportValidity()) return;
        testButton.disabled = true;
        testButton.textContent = "正在测试…";
        testResult.hidden = true;
        try {
          const values = { ...Object.fromEntries(new FormData(form).entries()), api: "auto" };
          const result = await window.bitAgent.testModelSettings(values);
          if (!active(body)) return;
          testResult.dataset.ok = String(result.ok);
          testResult.replaceChildren();
          const summary = document.createElement("strong");
          if (result.ok && result.api) {
            apiSelect.value = result.api;
            summary.textContent = `连接成功：${apiLabels[result.api]}，用时 ${result.latency_ms ?? "-"} ms。已选中这种接口类型，保存后生效。`;
          } else {
            summary.textContent = `连接失败：${result.message}`;
          }
          testResult.append(summary);
          const tried = (result.attempts ?? []).filter((item) => !result.ok || item.api !== result.api);
          if (tried.length) {
            const list = document.createElement("ul");
            for (const attempt of tried) {
              const item = document.createElement("li");
              item.textContent = `${apiLabels[attempt.api] ?? attempt.api}：${attempt.status_code ? `HTTP ${attempt.status_code}，` : ""}${attempt.message}`;
              list.append(item);
            }
            testResult.append(list);
          }
          testResult.hidden = false;
        } catch (error) { feedback(body, error); }
        finally { testButton.disabled = false; testButton.textContent = "测试连接"; }
      });
      form.onsubmit = async (event) => {
        event.preventDefault();
        const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        submit.disabled = true;
        submit.textContent = "正在保存…";
        try {
          const values = Object.fromEntries(new FormData(form).entries());
          await window.bitAgent.saveModelSettings(values);
          // 输入框里的模型菜单随之刷新。
          window.dispatchEvent(new Event("bit-agent:model-settings-saved"));
          (form.elements.namedItem("apiKey") as HTMLInputElement).value = "";
          form.querySelector(".model-key-state")!.textContent = "已配置";
          feedback(body, testResult.dataset.ok === "true"
            ? "设置已保存，将用于下一次任务。"
            : "设置已保存，将用于下一次任务。模型连接尚未验证，建议先测试连接。", true);
        } catch (error) { feedback(body, error); }
        finally { submit.disabled = false; submit.textContent = "保存设置"; }
      };
      body.append(form);
    } catch (error) { feedback(body, error); }
  }
  settingsButton.addEventListener("click", () => { void showModelSettings(); });
  compactSettings.addEventListener("click", () => { void showModelSettings(); });
  mountExecutionSettings();
  mountDockerNotice();
}

/** Docker 不可用时，在输入框上方提前说明：修改后的代码会显示“无法验证”。 */
function mountDockerNotice(): void {
  const dismissedKey = "bit-agent.docker-notice-dismissed.v1";
  const read = () => { try { return localStorage.getItem(dismissedKey); } catch { return null; } };
  const write = (value: string | null) => {
    try { if (value === null) localStorage.removeItem(dismissedKey); else localStorage.setItem(dismissedKey, value); } catch { /* 只影响提示是否再次出现 */ }
  };
  const notice = document.createElement("div");
  notice.className = "docker-notice";
  notice.setAttribute("role", "status");
  notice.hidden = true;
  const text = document.createElement("span");
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "docker-dismiss";
  dismiss.setAttribute("aria-label", "关闭提示");
  dismiss.title = "关闭提示（Docker 状态变化时会再提醒）";
  dismiss.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  notice.append(text, dismiss);
  document.querySelector(".composer-container")?.prepend(notice);
  let status = "";
  // 关掉后同一种状态不再提示；状态变了（比如装好或重新启动 Docker）会重新出现。
  dismiss.addEventListener("click", () => { write(status); notice.hidden = true; });
  let checkedAt = 0;
  const refresh = async (): Promise<void> => {
    if (Date.now() - checkedAt < 15_000) return;
    checkedAt = Date.now();
    try {
      status = await window.bitAgent.dockerStatus();
      if (status === "ready") write(null);
      notice.hidden = status === "ready" || read() === status;
      text.textContent = `${status === "not_installed" ? "没有找到 Docker" : "Docker 没有运行"}，`
        + "改动无法在隔离环境里测试，会标为“无法验证”。启动 Docker Desktop 后自动恢复。";
    } catch { notice.hidden = true; }
  };
  void refresh();
  window.addEventListener("focus", () => { void refresh(); });
}
