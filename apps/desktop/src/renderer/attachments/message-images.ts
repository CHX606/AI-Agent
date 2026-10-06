import { normalizeImages, type ImageAttachment } from "../../shared/image-input";
import { errorText, object } from "../dom";
import { previewOnClick } from "./image-preview";
import "./attachments.css";

function imageFigure(value: unknown): HTMLElement | null {
  const raw = object(value);
  if (!raw) return null;
  const name = typeof raw.name === "string" ? raw.name : "图片";
  const figure = document.createElement("figure");
  figure.className = "message-image";
  const caption = document.createElement("figcaption");
  caption.textContent = name;
  if (typeof raw.data_url === "string") {
    try {
      const image = normalizeImages([raw])[0]!;
      const preview = document.createElement("img");
      preview.src = image.data_url;
      preview.alt = name;
      preview.loading = "lazy";
      previewOnClick(preview, name);
      figure.append(preview);
    } catch (error) {
      caption.textContent = `${name}：无法预览图片`;
      caption.title = errorText(error);
      figure.dataset.unavailable = "true";
    }
  } else {
    caption.textContent = `图片：${name}`;
    figure.dataset.unavailable = "true";
  }
  figure.append(caption);
  return figure;
}

export function renderMessageImages(container: HTMLElement, value: unknown): void {
  container.querySelector(":scope > .message-images")?.remove();
  if (!Array.isArray(value) || !value.length) return;
  const gallery = document.createElement("div");
  gallery.className = "message-images";
  gallery.setAttribute("aria-label", "消息中的图片");
  for (const image of value) {
    const figure = imageFigure(image);
    if (figure) gallery.append(figure);
  }
  if (gallery.childElementCount) container.append(gallery);
}

export function savedImages(value: unknown): ImageAttachment[] {
  if (!Array.isArray(value)) return [];
  const full = value.filter(image => typeof object(image)?.data_url === "string");
  return normalizeImages(full);
}
