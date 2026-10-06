import { externalUrl, imageUrl } from "../../shared/external-url";
import { decorateCodeBlock } from "./code-block";

function clearClasses(fragment: DocumentFragment): void {
  for (const element of fragment.querySelectorAll("[class]")) {
    const language = element.tagName === "CODE" ? /\blanguage-[^\s]+/u.exec(element.className)?.[0] : undefined;
    if (language) element.setAttribute("class", language);
    else element.removeAttribute("class");
  }
}

function decorateLinks(fragment: DocumentFragment): void {
  for (const link of fragment.querySelectorAll<HTMLAnchorElement>("a")) {
    const url = externalUrl(link.getAttribute("href") ?? "");
    if (!url) { link.replaceWith(...link.childNodes); continue; }
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
}

function decorateImages(fragment: DocumentFragment): void {
  for (const image of fragment.querySelectorAll<HTMLImageElement>("img")) {
    const url = imageUrl(image.getAttribute("src") ?? "");
    if (!url) { image.replaceWith(document.createTextNode(image.alt)); continue; }
    image.src = url;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
  }
}

function decorateTasks(fragment: DocumentFragment): void {
  for (const input of fragment.querySelectorAll<HTMLInputElement>("input")) {
    const item = input.closest("li");
    if (input.type !== "checkbox" || !item) { input.remove(); continue; }
    input.disabled = true;
    input.className = "markdown-task-checkbox";
    item.classList.add("markdown-task-item");
  }
}

function decorateTables(fragment: DocumentFragment): void {
  for (const table of fragment.querySelectorAll("table")) {
    const wrapper = document.createElement("div");
    wrapper.className = "markdown-table";
    wrapper.tabIndex = 0;
    wrapper.setAttribute("aria-label", "表格，可横向滚动");
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
}

export function decorateMarkdown(fragment: DocumentFragment): void {
  clearClasses(fragment);
  decorateLinks(fragment);
  decorateImages(fragment);
  decorateTasks(fragment);
  decorateTables(fragment);
  for (const pre of fragment.querySelectorAll<HTMLPreElement>("pre")) decorateCodeBlock(pre);
}
