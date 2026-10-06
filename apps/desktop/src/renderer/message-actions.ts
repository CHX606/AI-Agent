/** 每条用户消息和每轮回答下面的图标行（复制，以及最后一轮的编辑、重新生成）。 */
import { copyButton, replyMarkdown } from "./copy-button";

export function actionRow(className: string, buttons: HTMLElement[]): HTMLElement {
  const row = document.createElement("div");
  row.className = `message-actions ${className}`;
  row.append(...buttons);
  return row;
}

export function iconButton(label: string, icon: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "turn-action";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = icon;
  button.addEventListener("click", action);
  return button;
}

export function userActions(text: () => string, extra: HTMLElement[] = []): HTMLElement {
  return actionRow("turn-user-actions", [copyButton(text, "复制这条消息", "turn-action"), ...extra]);
}

export function replyActions(stream: Element): HTMLElement {
  return actionRow("turn-reply-actions", [copyButton(() => replyMarkdown(stream), "复制回答", "turn-action")]);
}
