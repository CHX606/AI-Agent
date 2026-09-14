import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/translations/zh-cn.js";
import { DEFAULT_MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS_LIMIT, parseExecutionSettings } from "../shared/execution-settings.js";
import "./execution-settings.css";

export function mountExecutionSettings(): void {
  const icon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>`;
  const trigger = document.createElement("wa-button");
  trigger.id = "execution-settings";
  trigger.className = "execution-settings-trigger";
  trigger.appearance = "plain";
  trigger.variant = "neutral";
  trigger.size = "s";
  trigger.innerHTML = `<span slot="start">${icon}</span>执行设置`;
  document.querySelector("#model-settings")?.before(trigger);

  const compact = document.createElement("wa-button");
  compact.className = "execution-settings-compact";
  compact.appearance = "plain";
  compact.variant = "neutral";
  compact.size = "s";
  compact.setAttribute("aria-label", "执行设置");
  compact.title = "执行设置";
  compact.innerHTML = `${icon}<span class="sr-only">执行设置</span>`;
  document.querySelector("#theme-toggle")?.before(compact);

  const dialog = document.createElement("wa-dialog");
  dialog.id = "execution-settings-dialog";
  dialog.className = "execution-settings-dialog";
  dialog.label = "执行设置";
  dialog.innerHTML = `<wa-button slot="header-actions" id="execution-settings-close" appearance="plain" variant="neutral" size="s" aria-label="关闭执行设置">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
      <span class="sr-only">关闭执行设置</span>
    </wa-button>
    <form id="execution-settings-form" class="execution-settings-form">
      <p class="execution-settings-description">控制主 Agent 每次任务的执行预算。保存后，从下一次发送任务开始生效。</p>
      <wa-input id="max-tool-rounds" name="maxToolRounds" type="number" label="最大交互轮数"
        min="1" max="${MAX_TOOL_ROUNDS_LIMIT}" step="1" required value="${DEFAULT_MAX_TOOL_ROUNDS}" size="m"
        hint="可设置 1–${MAX_TOOL_ROUNDS_LIMIT} 轮，默认 ${DEFAULT_MAX_TOOL_ROUNDS} 轮。数值越大，可能消耗的时间和费用越多。">
        <span slot="end">轮</span>
      </wa-input>
      <div class="execution-settings-note">
        <p>轮数是模型与工具继续交互的次数，不是聊天消息数，也不是工具报错次数。</p>
        <p>此设置不改变正在运行的任务或子 Agent 的独立预算。达到上限仍会结束本次任务并提示错误；已经保存的进度会保留。</p>
      </div>
      <p id="execution-settings-feedback" class="product-feedback" role="status" aria-live="polite" hidden></p>
    </form>
    <div slot="footer" class="execution-settings-footer">
      <wa-button id="execution-settings-reset" appearance="plain" variant="neutral" size="s">恢复默认</wa-button>
      <wa-button id="execution-settings-cancel" appearance="outlined" variant="neutral" size="s">取消</wa-button>
      <wa-button id="execution-settings-save" type="submit" form="execution-settings-form" variant="brand" size="s">保存设置</wa-button>
    </div>`;
  document.body.append(dialog);
  const form = dialog.querySelector("form")!;
  const input = dialog.querySelector("wa-input")!;
  const save = dialog.querySelector("#execution-settings-save") as HTMLElementTagNameMap["wa-button"];
  const reset = dialog.querySelector("#execution-settings-reset") as HTMLElementTagNameMap["wa-button"];
  const cancel = dialog.querySelector("#execution-settings-cancel")!;
  const feedback = dialog.querySelector<HTMLParagraphElement>("#execution-settings-feedback")!;
  let generation = 0;
  let saving = false;

  function message(text: string, success = false): void {
    feedback.hidden = false;
    feedback.textContent = text;
    feedback.dataset.kind = success ? "success" : "error";
    feedback.setAttribute("role", success ? "status" : "alert");
  }
  function busy(value: boolean): void {
    input.disabled = value;
    save.disabled = value;
    reset.disabled = value;
    form.setAttribute("aria-busy", String(value));
  }
  async function open(): Promise<void> {
    const current = ++generation;
    feedback.hidden = true;
    input.value = String(DEFAULT_MAX_TOOL_ROUNDS);
    dialog.open = true;
    busy(true);
    try {
      const settings = await window.bitAgent.getExecutionSettings();
      if (current === generation && dialog.open) input.value = String(settings.maxToolRounds);
    } catch (error) {
      if (current === generation && dialog.open) message(error instanceof Error ? error.message : "执行设置读取失败，请重新保存");
    } finally {
      if (current === generation) busy(false);
    }
  }
  trigger.addEventListener("click", () => { void open(); });
  compact.addEventListener("click", () => { void open(); });
  cancel.addEventListener("click", () => { if (!saving) dialog.open = false; });
  dialog.querySelector("#execution-settings-close")!.addEventListener("click", () => { if (!saving) dialog.open = false; });
  reset.addEventListener("click", () => { input.value = String(DEFAULT_MAX_TOOL_ROUNDS); feedback.hidden = true; });
  input.addEventListener("input", () => { feedback.hidden = true; });
  dialog.addEventListener("wa-hide", (event) => {
    if (saving) event.preventDefault();
    else generation++;
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving || save.disabled) return;
    try {
      const settings = parseExecutionSettings({ maxToolRounds: Number(input.value) });
      saving = true;
      busy(true);
      save.loading = true;
      const saved = await window.bitAgent.saveExecutionSettings(settings);
      input.value = String(saved.maxToolRounds);
      message(`已保存：每次主任务最多 ${saved.maxToolRounds} 轮。下一次发送任务时生效。`, true);
    } catch (error) {
      message(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      saving = false;
      save.loading = false;
      busy(false);
    }
  });
}
