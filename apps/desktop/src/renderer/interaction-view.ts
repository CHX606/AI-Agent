import type { TaskInteractionInput, TaskRequestInput } from "../shared/contracts";
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
      <details class="operation-details" hidden><summary>展开完整操作详情</summary><pre></pre></details>
      <fieldset class="question-options"><legend class="sr-only">选择一个方案</legend></fieldset>
      <details class="question-free-answer"><summary>或者填写自己的回答</summary>
        <label class="sr-only" for="question-answer">自己的回答</label>
        <textarea id="question-answer" rows="2" maxlength="4000" placeholder="填写后将以你的文字回答为准"></textarea>
      </details>
      <div class="question-submit-row"><button id="submit-question-answer" class="button-primary" type="button">提交回答并继续</button></div>
    </div>
    <details class="intent-editor">
      <summary>补充要求或修改目标</summary>
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
    // 进入暂停时展开编辑区；重复刷新状态时，不打断用户手动展开或收起。
    if (paintedStatus !== status) intentEditor.open = status === "PAUSED";
    paintedStatus = status;
    notice.textContent = status === "PAUSED"
      ? "任务已暂停，可以调整要求或直接继续。"
      : status === "WAITING_FOR_INPUT"
        ? "需要你的回答"
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
        error.textContent = failure instanceof Error ? failure.message : String(failure);
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
    operationDetails.querySelector("pre")!.textContent = String(operation?.detail ?? "");
    if (changed) {
      freeAnswer.value = "";
      find<HTMLDetailsElement>(".question-free-answer").open = false;
      operationDetails.open = false;
      panelBody.scrollTop = 0;
      options.replaceChildren();
      const legend = document.createElement("legend");
      legend.className = "sr-only";
      legend.textContent = "选择一个方案";
      options.append(legend);
      questionTitle.textContent = typeof question?.question === "string" ? question.question : "";
      if (Array.isArray(question?.options)) {
        for (const raw of question.options) {
          const option = record(raw);
          if (typeof option?.id !== "string" || typeof option.label !== "string") continue;
          const label = document.createElement("label");
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = "agent-question-option";
          radio.value = option.id;
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
          label.append(radio, copy);
          options.append(label);
        }
      }
    }
    updateCountdown();
    paint();
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
  };
}
