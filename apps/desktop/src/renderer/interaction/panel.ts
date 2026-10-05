import { element } from "../dom";

const template = `
  <div class="interaction-heading">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z"/><path d="M8 9h8m-8 4h5"/></svg>
    <p class="interaction-notice" aria-live="polite"></p>
    <button id="end-task" class="interaction-end" type="button" title="结束这一轮，记录和已改的文件都保留；之后可以在同一对话继续">结束这一轮</button>
  </div>
  <div class="interaction-body">
    <p class="interaction-error" role="alert" hidden></p>
    <div class="interaction-question" hidden>
      <h3 class="question-title"></h3>
      <p class="question-deadline" aria-live="off"></p>
      <details class="operation-details" hidden><summary>操作详情</summary><pre></pre></details>
      <fieldset class="question-options"><legend class="sr-only">选择一个方案</legend></fieldset>
      <div class="question-submit-row"><button id="submit-question-answer" class="button-primary" type="button">提交</button></div>
    </div>
    <details class="intent-editor">
      <summary>修改目标（替换原目标和原计划）</summary>
      <label class="sr-only" for="intent-input">新的任务目标</label>
      <textarea id="intent-input" rows="2" maxlength="4000" placeholder="写下新的目标；原目标和还没执行的计划都会作废…"></textarea>
      <p class="intent-note">补充要求不用在这里写：直接在下方输入框按 Enter。已完成的文件修改不会自动撤销。</p>
      <div class="interaction-actions">
        <button id="apply-intent" class="button-primary" type="button">替换目标并继续</button>
      </div>
    </details>
  </div>`;

export function mountInteractionPanel() {
  const cancel = element<HTMLButtonElement>("#cancel");
  const composer = element<HTMLTextAreaElement>("#objective");
  const panel = document.createElement("section");
  panel.className = "task-interaction";
  panel.id = "task-interaction";
  panel.hidden = true;
  panel.innerHTML = template;
  composer.closest(".composer-card")!.before(panel);
  const find = <T extends HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  return {
    cancel, composer, panel,
    notice: find<HTMLParagraphElement>(".interaction-notice"),
    error: find<HTMLParagraphElement>(".interaction-error"),
    questionBox: find<HTMLDivElement>(".interaction-question"),
    questionTitle: find<HTMLElement>(".question-title"),
    deadlineText: find<HTMLParagraphElement>(".question-deadline"),
    operationDetails: find<HTMLDetailsElement>(".operation-details"),
    options: find<HTMLFieldSetElement>(".question-options"),
    answerButton: find<HTMLButtonElement>("#submit-question-answer"),
    intent: find<HTMLTextAreaElement>("#intent-input"),
    applyButton: find<HTMLButtonElement>("#apply-intent"),
    endTask: find<HTMLButtonElement>("#end-task"),
    intentEditor: find<HTMLDetailsElement>(".intent-editor"),
    panelBody: find<HTMLDivElement>(".interaction-body"),
  };
}

export type InteractionElements = ReturnType<typeof mountInteractionPanel>;
