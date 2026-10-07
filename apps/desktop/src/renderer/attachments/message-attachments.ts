import { normalizeAttachments, type FileAttachment } from "../../shared/attachment-input";
import { errorText, object } from "../dom";
import { attachmentCard, attachmentDetails } from "./attachment-card";
import "./attachments.css";

export function renderMessageAttachments(container: HTMLElement, value: unknown): void {
  container.querySelector(":scope > .message-attachments")?.remove();
  if (!Array.isArray(value) || !value.length) return;
  const list = document.createElement("div");
  list.className = "message-attachments";
  list.setAttribute("aria-label", "消息中的附件");
  for (const raw of value) {
    try {
      const details = attachmentDetails(raw);
      if (details) list.append(attachmentCard(details));
    } catch (error) { list.append(unavailableAttachment(raw, error)); }
  }
  if (list.childElementCount) container.append(list);
}

function unavailableAttachment(raw: unknown, error: unknown): HTMLElement {
  const card = document.createElement("div");
  card.className = "attachment-card";
  card.dataset.unavailable = "true";
  card.textContent = `${String(object(raw)?.name ?? "附件")}：无法读取附件`;
  card.title = errorText(error);
  return card;
}

export function savedAttachments(value: unknown): FileAttachment[] {
  if (!Array.isArray(value)) return [];
  return normalizeAttachments(value.filter(item => typeof object(item)?.data_url === "string"));
}
