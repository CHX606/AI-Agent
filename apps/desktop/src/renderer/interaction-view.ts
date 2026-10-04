import type { TaskInteractionInput, TaskRequestInput } from "../shared/contracts";
import { errorText } from "./dom";
import "./interaction-view.css";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function createInteractionView(callbacks: {
  current(): TaskRequestInput;
  apply(task: Record<string, unknown>): void;
}) {
  const cancel = document.querySelector<HTMLButtonElement>("#cancel")!;
  const composer = document.querySelector<HTMLTextAreaElement>("#objective")!;
  const pause = document.createElement("button");
  pause.id = "pause-task";
  pause.type = "button";
  pause.className = "interaction-pause";
  pause.textContent = "暂停";
  pause.hidden = true;
  cancel.before(pause);

  const panel = document.createElement("section");
  panel.className = "task-interaction";
  panel.id = "task-interaction";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="interaction-heading">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z"/><path d="M8 9h8m-8 4h5"/></svg>
      <p class="interaction-notice" aria-live="polite"></p>
      <button id="resume-task" class="button-secondary" type="button">继续执行</button>
    </div>
    <div class="interaction-body">
    <p class="interaction-error" role="alert" hidden></p>
    <div class="interaction-question" hidden>
      <h3 class="question-title"></h3>
      <p class="question-deadline" aria-live="off"></p>
      <details class="operation-details" hidden><summary>操作详情</summary><pre></pre></details>
      <fieldset class="question-options"><legend class="sr-only">选择一个方案</legend></fieldset>
      <details class="question-free-answer"><summary>或者填写自己的回答</summary>
        <label class="sr-only" for="question-answer">自己的回答</label>
        <textarea id="question-answer" rows="2" maxlength="4000" placeholder="填写后将以你的文字回答为准"></textarea>
      </details>
      <div class="question-submit-row"><button id="submit-question-answer" class="button-primary" type="button">提交回答并继续</button></div>
    </div>
    <details class="intent-editor">
      <summary>修改目标（替换原目标和原计划）</summary>
      <div class="intent-kind-row"><label for="intent-kind">调整方式</label>
      <select id="intent-kind">
        <option value="supplement">补充要求：保留原目标</option>
        <option value="replace">修改目标：替换原目标和原计划</option>
      </select></div>
      <label class="sr-only" for="intent-input">新的任务要求</label>
      <textarea id="intent-input" rows="2" maxlength="4000" placeholder="写下你想补充或调整的要求…"></textarea>
      <p class="intent-note">提交后按新要求继续，当前问题不再回答；已完成的文件修改不会自动撤销。</p>
      <div class="interaction-actions">
        <button id="apply-intent" class="button-primary" type="button">提交要求并继续</button>
      </div>
    </details>
    </div>`;
  composer.closest(".composer-card")!.before(panel);

  const find = <T extends HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  const notice = find<HTMLParagraphElement>(".interaction-notice");
  const error = find<HTMLParagraphElement>(".interaction-error");
  const questionBox = find<HTMLDivElement>(".interaction-question");
  const questionTitle = find<HTMLElement>(".question-title");
  const deadlineText = find<HTMLParagraphElement>(".question-deadline");
  const options = find<HTMLFieldSetElement>(".question-options");
  const freeAnswer = find<HTMLTextAreaElement>("#question-answer");
  const answerButton = find<HTMLButtonElement>("#submit-question-answer");
  const intent = find<HTMLTextAreaElement>("#intent-input");
  const intentKind = find<HTMLSelectElement>("#intent-kind");
  const applyButton = find<HTMLButtonElement>("#apply-intent");
  const resume = find<HTMLButtonElement>("#resume-task");
  const intentEditor = find<HTMLDetailsElement>(".intent-editor");
  const panelBody = find<HTMLDivElement>(".interaction-body");
  let status = "IDLE";
  let paintedStatus = "";
  let taskId = "";
  let question: Record<string, unknown> | null = null;
  let sending = false;
  const running = new Set(["QUEUED", "RUNNING", "PAUSE_REQUESTED", "PAUSED", "WAITING_FOR_INPUT"]);

  function paint(): void {
    const editable = status === "PAUSED" || status === "WAITING_FOR_INPUT";
    pause.hidden = !running.has(status);
    pause.disabled = sending || status !== "RUNNING" && status !== "QUEUED";
    pause.textContent = status === "PAUSE_REQUESTED" ? "正在暂停" : "暂停";
    panel.hidden = !editable && status !== "PAUSE_REQUESTED" && error.hidden;
    panel.dataset.status = status;
    panelBody.hidden = !editable && error.hidden;
    intentEditor.hidden = !editable;
    // 补充要求直接写在下方输入框里按 Enter；这里只在需要“替换目标”时手动展开。
    if (paintedStatus !== status) intentEditor.open = false;
    paintedStatus = status;
    notice.textContent = status === "PAUSED"
      ? "已暂停。在下方输入框写补充要求后按 Enter，或直接继续执行。"
      : status === "WAITING_FOR_INPUT"
        ? "需要你的回答（按数字键选择；也可以在下方输入框直接写新的要求）"
        : status === "PAUSE_REQUESTED"
          ? "正在等待当前调用结束，随后暂停。"
          : "操作未完成，请查看下面的提示。";
    intent.disabled = !editable || sending;
    intentKind.disabled = !editable || sending;
    applyButton.disabled = !editable || sending;
    resume.hidden = status !== "PAUSED";
    resume.disabled = sending;
    questionBox.hidden = status !== "WAITING_FOR_INPUT" || question === null;
    answerButton.disabled = sending;
    freeAnswer.disabled = sending;
    options.disabled = sending;
  }

  function matches(input: TaskRequestInput): boolean {
    try {
      const current = callbacks.current();
      return current.taskId === input.taskId && current.gatewayUrl === input.gatewayUrl;
    } catch { return false; }
  }

  async function submit(body: Omit<TaskInteractionInput, keyof TaskRequestInput>): Promise<boolean> {
    if (sending) return false;
    const input = callbacks.current();
    sending = true;
    error.hidden = true;
    paint();
    try {
      const task = await window.bitAgent.interactTask({ ...input, ...body });
      if (!matches(input)) return false;
      callbacks.apply(task);
      return true;
    } catch (failure) {
      if (matches(input)) {
        error.textContent = errorText(failure);
        error.hidden = false;
        // 过期问题不能重发到下一题；先取回服务端的最新状态。
        try {
          const task = await window.bitAgent.getTask(input);
          if (matches(input)) callbacks.apply(task);
        } catch { /* 保留原错误，不把接口拒绝误当成任务失败。 */ }
      }
      return false;
    } finally {
      sending = false;
      paint();
    }
  }

  pause.addEventListener("click", () => { void submit({ action: "pause" }); });
  resume.addEventListener("click", () => { void submit({ action: "resume" }); });
  applyButton.addEventListener("click", async () => {
    const text = intent.value.trim();
    if (!text) { intent.focus(); return; }
    const kind = intentKind.value === "replace" ? "replace" : "supplement";
    if (await submit({ action: kind, text })) intent.value = "";
  });
  answerButton.addEventListener("click", () => {
    if (typeof question?.id !== "string") return;
    const text = freeAnswer.value.trim();
    const selected = options.querySelector<HTMLInputElement>("input:checked")?.value;
    if (!text && !selected) {
      error.textContent = "请选择一个选项，或填写自己的回答。";
      error.hidden = false;
      paint();
      return;
    }
    void submit({
      action: "answer", questionId: question.id,
      ...(text ? { text } : { optionId: selected! }),
    });
  });

  /** 补丁按差异着色；其他操作详情原样显示。 */
  function renderOperation(pre: HTMLElement, detail: string): void {
    pre.replaceChildren();
    for (const line of detail.split("\n")) {
      const row = document.createElement("span");
      row.className = /^\+(?!\+\+)/u.test(line) ? "op-add" : /^-(?!--)/u.test(line) ? "op-remove"
        : line.startsWith("@@") ? "op-hunk" : "op-context";
      row.textContent = line || " ";
      pre.append(row);
    }
  }

  // 键盘作答：按数字选择对应选项并提交；选中后按 Enter 提交。正在输入文字时不拦截。
  document.addEventListener("keydown", (event) => {
    if (questionBox.hidden || panel.hidden || sending || event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("textarea, input[type=text], select, [contenteditable=true]")) return;
    if (target && target !== document.body && !panel.contains(target) && target.id !== "objective") return;
    const radios = [...options.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    const digit = Number.parseInt(event.key, 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= radios.length) {
      event.preventDefault();
      radios[digit - 1]!.checked = true;
      answerButton.click();
    } else if (event.key === "Enter" && radios.some((radio) => radio.checked)) {
      event.preventDefault();
      answerButton.click();
    }
  });

  function reset(): void {
    taskId = "";
    status = "IDLE";
    paintedStatus = "";
    question = null;
    intent.value = "";
    freeAnswer.value = "";
    error.hidden = true;
    paint();
  }

  function update(task: Record<string, unknown>): void {
    if (typeof task.task_id === "string" && task.task_id !== taskId) {
      reset();
      taskId = task.task_id;
    }
    status = typeof task.status === "string" ? task.status : status;
    const next = record(task.question);
    const changed = next?.id !== question?.id;
    question = next;
    const operation = record(question?.operation);
    const operationDetails = find<HTMLDetailsElement>(".operation-details");
    operationDetails.hidden = typeof operation?.detail !== "string";
    renderOperation(operationDetails.querySelector("pre")!, String(operation?.detail ?? ""));
    if (changed) {
      freeAnswer.value = "";
      find<HTMLDetailsElement>(".question-free-answer").open = false;
      // 批准写文件时直接展开差异，和 Claude Code 先给你看改动再问要不要写一样。
      operationDetails.open = typeof operation?.detail === "string";
      panelBody.scrollTop = 0;
      options.replaceChildren();
      const legend = document.createElement("legend");
      legend.className = "sr-only";
      legend.textContent = "选择一个方案";
      options.append(legend);
      // 权限确认的标题只取第一行（例如“写入以下补丁”），补丁正文在下面的差异框里。
      const text = typeof question?.question === "string" ? question.question : "";
      questionTitle.textContent = typeof operation?.title === "string" ? operation.title : text;
      if (Array.isArray(question?.options)) {
        let index = 0;
        for (const raw of question.options) {
          const option = record(raw);
          if (typeof option?.id !== "string" || typeof option.label !== "string") continue;
          index += 1;
          const label = document.createElement("label");
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = "agent-question-option";
          radio.value = option.id;
          const number = document.createElement("span");
          number.className = "option-index";
          number.textContent = `${index}.`;
          const copy = document.createElement("span");
          const title = document.createElement("strong");
          title.textContent = option.label;
          if (option.id === question?.recommended_option_id) {
            const badge = document.createElement("span");
            badge.className = "question-recommendation";
            badge.textContent = "推荐";
            title.append(badge);
          }
          const description = document.createElement("small");
          description.textContent = String(option.description ?? "");
          copy.append(title, description);
          label.append(radio, number, copy);
          options.append(label);
        }
      }
    }
    updateCountdown();
    paint();
    // 新问题出现时把焦点交给第一个选项，可以直接按数字键作答（输入框里有未发送的文字时不抢焦点）。
    if (changed && question && !composer.value.trim()) {
      options.querySelector<HTMLInputElement>("input[type=radio]")?.focus({ preventScroll: true });
    }
  }

  function updateCountdown(): void {
    if (question?.requires_confirmation) {
      deadlineText.textContent = "需要你明确回答，不会因为超时自动同意。";
    } else if (typeof question?.expires_at === "string") {
      const remaining = Math.max(0, Math.ceil((Date.parse(question.expires_at) - Date.now()) / 1000));
      deadlineText.textContent = remaining > 0
        ? `${remaining} 秒内未回答，将采用推荐项。推荐不代表一定最优。`
        : "等待后端确认超时结果，请勿重复提交。";
    } else {
      deadlineText.textContent = "";
    }
  }
  // 这里只显示倒计时；真正的超时决定在 Python，不依赖页面是否打开。
  const timer = window.setInterval(updateCountdown, 1000);
  window.addEventListener("beforeunload", () => window.clearInterval(timer), { once: true });
  return {
    update, reset,
    setStatus(value: string): void { status = value; paint(); },
    /** 暂停或等待回答时，把输入框里的文字作为补充要求提交；当前问题随之失效，Agent 重新规划。 */
    supplement(text: string): Promise<boolean> { return submit({ action: "supplement", text }); },
  };
}
