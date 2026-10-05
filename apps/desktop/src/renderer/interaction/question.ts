import { object } from "../dom";
import type { InteractionElements } from "./panel";

type Question = Record<string, unknown>;

/** 补丁按差异着色，git 头信息只留一行文件名。 */
function renderOperation(pre: HTMLElement, detail: string): void {
  pre.replaceChildren();
  for (const line of detail.split("\n")) {
    const file = /^diff --git a\/(.+?) b\//u.exec(line);
    if (/^(new|deleted) file mode |^index |^--- |^\+\+\+ /u.test(line)) continue;
    const row = document.createElement("span");
    row.className = file ? "op-file" : /^\+(?!\+\+)/u.test(line) ? "op-add"
      : /^-(?!--)/u.test(line) ? "op-remove" : line.startsWith("@@") ? "op-hunk" : "op-context";
    row.textContent = file ? file[1]! : line || " ";
    pre.append(row);
  }
  while (pre.lastElementChild?.textContent === " ") pre.lastElementChild.remove();
}

function optionLabel(option: Question, index: number, recommended: boolean): HTMLLabelElement {
  const label = document.createElement("label");
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "agent-question-option";
  radio.value = String(option.id);
  const number = document.createElement("span");
  number.className = "option-index";
  number.textContent = `${index}.`;
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = String(option.label);
  if (recommended) {
    const badge = document.createElement("span");
    badge.className = "question-recommendation";
    badge.textContent = "推荐";
    title.append(badge);
  }
  const description = document.createElement("small");
  description.textContent = String(option.description ?? "");
  copy.append(title, description);
  label.append(radio, number, copy);
  return label;
}

export class InteractionQuestion {
  private question: Question | null = null;

  constructor(private readonly elements: InteractionElements) {}

  id(): string | null {
    return typeof this.question?.id === "string" ? this.question.id : null;
  }

  kind(): "approval" | "question" | null {
    if (!this.question) return null;
    return object(this.question.operation) ? "approval" : "question";
  }

  clear(): void {
    this.question = null;
    const ui = this.elements;
    ui.questionBox.hidden = true;
    ui.questionTitle.textContent = "";
    ui.deadlineText.textContent = "";
    ui.deadlineText.hidden = true;
    ui.operationDetails.hidden = true;
    ui.operationDetails.open = false;
    ui.operationDetails.querySelector("pre")!.replaceChildren();
    ui.options.replaceChildren();
  }

  update(question: Question | null): void {
    if (!question) { this.clear(); return; }
    const changed = question.id !== this.question?.id;
    this.question = question;
    const ui = this.elements;
    const operation = object(question.operation);
    ui.operationDetails.hidden = typeof operation?.detail !== "string";
    renderOperation(ui.operationDetails.querySelector("pre")!, String(operation?.detail ?? ""));
    if (changed) {
      ui.operationDetails.open = typeof operation?.detail === "string";
      ui.panelBody.scrollTop = 0;
      ui.questionTitle.textContent = typeof operation?.title === "string"
        ? operation.title : String(question.question ?? "");
      this.renderOptions(question, operation !== null);
    }
    this.updateCountdown();
    if (changed && !ui.composer.disabled && (!document.activeElement || document.activeElement === document.body)) {
      ui.composer.focus({ preventScroll: true });
    }
  }

  private renderOptions(question: Question, approval: boolean): void {
    const options = this.elements.options;
    options.replaceChildren();
    const legend = document.createElement("legend");
    legend.className = "sr-only";
    legend.textContent = "选择一个方案";
    options.append(legend);
    if (!Array.isArray(question.options)) return;
    let index = 0;
    for (const raw of question.options) {
      const option = object(raw);
      if (typeof option?.id !== "string" || typeof option.label !== "string") continue;
      const label = optionLabel(option, ++index, !approval && option.id === question.recommended_option_id);
      if (approval) label.dataset.choice = option.id;
      options.append(label);
    }
  }

  updateCountdown(): void {
    const deadline = this.elements.deadlineText;
    const question = this.question;
    if (object(question?.operation)) {
      deadline.textContent = "";
    } else if (question?.requires_confirmation) {
      deadline.textContent = "需要你明确回答，不会因为超时自动采用推荐项。";
    } else if (typeof question?.expires_at === "string") {
      const remaining = Math.max(0, Math.ceil((Date.parse(question.expires_at) - Date.now()) / 1000));
      const clock = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
      deadline.textContent = remaining > 0
        ? `${clock} 内没有回答，将采用推荐项继续。推荐不代表一定最优。`
        : "等待后端确认超时结果，请勿重复提交。";
    } else {
      deadline.textContent = "";
    }
    deadline.hidden = !deadline.textContent;
  }
}
