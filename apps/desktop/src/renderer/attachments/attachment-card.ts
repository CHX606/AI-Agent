import { attachmentSize, normalizeAttachments } from "../../shared/attachment-input";
import { object } from "../dom";

export interface AttachmentDetails { name: string; mime: string; size: number | null }

export function attachmentDetails(value: unknown): AttachmentDetails | null {
  const raw = object(value);
  if (!raw || typeof raw.name !== "string") return null;
  const mime = typeof raw.mime_type === "string" ? raw.mime_type : "application/octet-stream";
  let size = typeof raw.size === "number" ? raw.size : null;
  if (typeof raw.data_url === "string") size = attachmentSize(normalizeAttachments([{ name: raw.name, mime_type: mime, data_url: raw.data_url }])[0]!);
  return { name: raw.name, mime, size };
}

export function attachmentKey(details: AttachmentDetails): string {
  return JSON.stringify([details.name, details.mime, details.size]);
}

export function attachmentSizeText(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function attachmentCard(details: AttachmentDetails): HTMLElement {
  const card = document.createElement("div");
  card.className = "attachment-card";
  card.dataset.attachmentKey = attachmentKey(details);
  const icon = document.createElement("span");
  icon.className = "attachment-file-icon";
  icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/></svg>';
  const copy = document.createElement("span");
  copy.className = "attachment-file-copy";
  const name = document.createElement("strong");
  name.textContent = details.name;
  name.title = details.name;
  const summary = document.createElement("span");
  const extension = details.name.includes(".") ? details.name.split(".").at(-1)! : "";
  const type = extension && extension.length <= 12 ? extension.toUpperCase() : "文件";
  summary.textContent = [type, attachmentSizeText(details.size)].filter(Boolean).join(" · ");
  summary.title = details.mime;
  copy.append(name, summary);
  card.append(icon, copy);
  return card;
}
