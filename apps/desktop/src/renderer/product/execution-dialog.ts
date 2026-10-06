import { DEFAULT_MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS_LIMIT, type AcceptanceMode } from "../../shared/execution-settings.js";

// 门槛与后端 runtime/domain/acceptance_policy.py 一致：60 行或 3 个代码文件。
export const acceptanceChoices: [AcceptanceMode, string, string][] = [
  ["auto", "自动（推荐）", "改动达到 60 行或 3 个代码文件时验收；小改动只做基础检查，省下几分钟。"],
  ["always", "每次修改都验收", "最稳妥，但每次通常要多等几分钟、多用一些 tokens。"],
  ["off", "关闭", "只做基础检查：运行项目已有的测试和代码检查。"],
];

const executionFormHtml = `<wa-button slot="header-actions" id="execution-settings-close" appearance="plain" variant="neutral" size="s" aria-label="关闭执行设置">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
      <span class="sr-only">关闭执行设置</span>
    </wa-button>
    <form id="execution-settings-form" class="execution-settings-form">
      <p class="execution-settings-description">控制主 Agent 的执行预算和修改后的验收方式。保存后，从下一次发送任务开始生效。</p>
      <wa-input id="max-tool-rounds" name="maxToolRounds" type="number" label="最大交互轮数"
        min="1" max="${MAX_TOOL_ROUNDS_LIMIT}" step="1" required value="${DEFAULT_MAX_TOOL_ROUNDS}" size="m"
        hint="可设置 1–${MAX_TOOL_ROUNDS_LIMIT} 轮，默认 ${DEFAULT_MAX_TOOL_ROUNDS} 轮。数值越大，可能消耗的时间和费用越多。">
        <span slot="end">轮</span>
      </wa-input>
      <div class="execution-settings-note">
        <p>轮数是模型与工具继续交互的次数，不是聊天消息数，也不是工具报错次数。</p>
        <p>此设置不改变正在运行的任务或子 Agent 的独立预算。达到上限仍会结束本次任务并提示错误；已经保存的进度会保留。</p>
      </div>
      <fieldset id="acceptance-mode" class="execution-acceptance">
        <legend>独立验收</legend>
        <p class="execution-acceptance-intro">修改代码并通过基础检查后，是否另派一个测试 Agent 按你的原始需求写测试、再验收一遍。</p>
        ${acceptanceChoices.map(([value, title, detail]) => `<label class="execution-choice">
          <input type="radio" name="acceptanceMode" value="${value}">
          <span><strong>${title}</strong><small>${detail}</small></span>
        </label>`).join("")}
      </fieldset>
      <p id="execution-settings-feedback" class="product-feedback" role="status" aria-live="polite" hidden></p>
    </form>
    <div slot="footer" class="execution-settings-footer">
      <wa-button id="execution-settings-reset" appearance="plain" variant="neutral" size="s">恢复默认</wa-button>
      <wa-button id="execution-settings-cancel" appearance="outlined" variant="neutral" size="s">取消</wa-button>
      <wa-button id="execution-settings-save" type="submit" form="execution-settings-form" variant="brand" size="s">保存设置</wa-button>
    </div>`;

export function createExecutionDialog(): HTMLElementTagNameMap["wa-dialog"] {
  const dialog = document.createElement("wa-dialog");
  dialog.id = "execution-settings-dialog";
  dialog.className = "execution-settings-dialog";
  dialog.label = "执行设置";
  dialog.innerHTML = executionFormHtml;
  document.body.append(dialog);
  return dialog;
}
