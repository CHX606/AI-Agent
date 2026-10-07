import type { FileAttachment } from "../../shared/attachment-input";
import type { TaskInteractionInput, TaskRequestInput } from "../../shared/contracts";
import type { ImageAttachment } from "../../shared/image-input";
import { errorText, object } from "../dom";
import { mountInteractionPanel } from "./panel";
import { InteractionQuestion } from "./question";

export interface InteractionCallbacks {
  current(): TaskRequestInput;
  apply(task: Record<string, unknown>): void;
}

type InteractionBody = Omit<TaskInteractionInput, keyof TaskRequestInput>;
const hiddenStatuses = new Set(["PAUSE_REQUESTED", "PAUSED", "CANCELLATION_REQUESTED", "CANCELLED"]);

export class InteractionController {
  private readonly ui = mountInteractionPanel();
  private readonly questions = new InteractionQuestion(this.ui);
  private status = "IDLE";
  private paintedStatus = "";
  private taskId = "";
  private sending = false;

  constructor(private readonly callbacks: InteractionCallbacks) {
    this.bindControls();
    this.paint();
    const timer = window.setInterval(() => this.questions.updateCountdown(), 1000);
    window.addEventListener("beforeunload", () => window.clearInterval(timer), { once: true });
  }

  private paint(): void {
    const ui = this.ui;
    const editable = this.status === "WAITING_FOR_INPUT";
    const hidden = hiddenStatuses.has(this.status);
    if (!editable) this.questions.clear();
    if (hidden) { ui.error.hidden = true; ui.error.textContent = ""; }
    ui.endTask.hidden = !editable;
    ui.endTask.disabled = this.sending;
    ui.panel.hidden = hidden || (!editable && ui.error.hidden);
    ui.panel.dataset.status = this.status;
    ui.panel.dataset.kind = this.pendingKind() ?? "";
    ui.panelBody.hidden = !editable && ui.error.hidden;
    ui.intentEditor.hidden = !editable;
    if (this.paintedStatus !== this.status) ui.intentEditor.open = false;
    this.paintedStatus = this.status;
    ui.notice.textContent = editable
      ? this.pendingKind() === "approval"
        ? "需要你批准 · 按数字键选择；不批准可以在下方输入框写下原因"
        : "Agent 在问你 · 按数字键选择，或在下方输入框直接回答"
      : "操作未完成，请查看下面的提示。";
    ui.intent.disabled = !editable || this.sending;
    ui.applyButton.disabled = !editable || this.sending;
    ui.questionBox.hidden = !editable || this.questions.id() === null;
    ui.answerButton.disabled = this.sending;
    ui.options.disabled = this.sending;
  }

  private matches(input: TaskRequestInput): boolean {
    try {
      const current = this.callbacks.current();
      return current.taskId === input.taskId && current.gatewayUrl === input.gatewayUrl;
    } catch { return false; }
  }

  private async showError(failure: unknown, input: TaskRequestInput): Promise<void> {
    if (!this.matches(input) || hiddenStatuses.has(this.status)) return;
    this.ui.error.textContent = errorText(failure);
    this.ui.error.hidden = false;
    try {
      const task = await window.bitAgent.getTask(input);
      if (this.matches(input)) this.callbacks.apply(task);
    } catch (refreshFailure) {
      if (this.matches(input)) {
        this.ui.error.textContent += ` 状态刷新失败：${errorText(refreshFailure)}`;
      }
    }
  }

  private async submit(body: InteractionBody): Promise<boolean> {
    if (this.sending) return false;
    const input = this.callbacks.current();
    this.sending = true;
    this.ui.error.hidden = true;
    this.paint();
    try {
      const task = await window.bitAgent.interactTask({ ...input, ...body });
      if (!this.matches(input) || (body.action !== "resume" && hiddenStatuses.has(this.status))) return false;
      this.callbacks.apply(task);
      return true;
    } catch (failure) {
      await this.showError(failure, input);
      return false;
    } finally {
      this.sending = false;
      this.paint();
    }
  }

  private bindControls(): void {
    const ui = this.ui;
    ui.endTask.addEventListener("click", () => ui.cancel.click());
    ui.applyButton.addEventListener("click", () => { void this.replaceIntent(); });
    ui.answerButton.addEventListener("click", () => this.submitChoice());
    ui.options.addEventListener("click", (event) => this.chooseOption(event));
    document.addEventListener("keydown", (event) => this.handleQuestionKey(event));
  }

  private async replaceIntent(): Promise<void> {
    const text = this.ui.intent.value.trim();
    if (!text) { this.ui.intent.focus(); return; }
    if (await this.submit({ action: "replace", text })) this.ui.intent.value = "";
  }

  private submitChoice(): void {
    const questionId = this.questions.id();
    if (questionId === null) return;
    const selected = this.ui.options.querySelector<HTMLInputElement>("input:checked")?.value;
    if (!selected) {
      this.ui.error.textContent = this.pendingKind() === "approval"
        ? "请选择一项；不批准也可以在下方输入框写下原因。"
        : "请选择一项，或在下方输入框直接写下回答。";
      this.ui.error.hidden = false;
      this.paint();
      return;
    }
    void this.submit({ action: "answer", questionId, optionId: selected });
  }

  private chooseOption(event: MouseEvent): void {
    if (event.detail === 0 || this.sending || this.ui.panel.hidden) return;
    const radio = (event.target as HTMLElement).closest("label")?.querySelector<HTMLInputElement>("input[type=radio]");
    if (!radio) return;
    event.preventDefault();
    radio.checked = true;
    this.ui.answerButton.click();
  }

  private handleQuestionKey(event: KeyboardEvent): void {
    const ui = this.ui;
    if (ui.questionBox.hidden || ui.panel.hidden || this.sending || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.isComposing) return;
    const target = event.target as HTMLElement | null;
    const inEmptyComposer = target === ui.composer && !ui.composer.value.trim();
    if (!inEmptyComposer && target?.closest("textarea, input[type=text], select, [contenteditable=true]")) return;
    if (target && target !== document.body && !ui.panel.contains(target) && !inEmptyComposer) return;
    if (inEmptyComposer && event.key === "Enter") return;
    const radios = [...ui.options.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    const digit = Number.parseInt(event.key, 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= radios.length) {
      event.preventDefault();
      radios[digit - 1]!.checked = true;
      ui.answerButton.click();
    } else if (event.key === "Enter" && radios.some((radio) => radio.checked)) {
      event.preventDefault();
      ui.answerButton.click();
    }
  }

  reset(): void {
    this.taskId = "";
    this.status = "IDLE";
    this.paintedStatus = "";
    this.questions.clear();
    this.ui.intent.value = "";
    this.ui.error.hidden = true;
    this.paint();
  }

  update(task: Record<string, unknown>): void {
    if (typeof task.task_id === "string" && task.task_id !== this.taskId) {
      this.reset();
      this.taskId = task.task_id;
    }
    this.status = typeof task.status === "string" ? task.status : this.status;
    this.questions.update(this.status === "WAITING_FOR_INPUT" ? object(task.question) : null);
    this.paint();
  }

  setStatus(value: string): void {
    this.status = value;
    this.paint();
  }

  pendingKind(): "approval" | "question" | null {
    return this.status === "WAITING_FOR_INPUT" ? this.questions.kind() : null;
  }

  /** 在输入框补充要求，运行时会交给 Agent 的下一步。 */
  supplement(text: string, images: ImageAttachment[] = [], attachments: FileAttachment[] = []): Promise<boolean> {
    return this.submit({ action: "supplement", text, ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}) });
  }

  /** 权限确认时，文字回答表示不批准，并说明原因。 */
  answer(text: string, images: ImageAttachment[] = [], attachments: FileAttachment[] = []): Promise<boolean> {
    const questionId = this.questions.id();
    return questionId === null ? Promise.resolve(false)
      : this.submit({ action: "answer", questionId, text, ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}) });
  }

  /** 保留安全暂停接口，后台处理期间无需显示额外面板。 */
  pause(): Promise<boolean> {
    return this.submit({ action: "pause" });
  }

  resume(): Promise<boolean> {
    return this.submit({ action: "resume" });
  }
}
