import { errorText } from "../dom.js";

type ViewKind = "model" | "review" | "diagnostics" | "memory" | "mcp";

export class ProductDialog {
  private readonly modal: HTMLDialogElement;

  constructor() {
    this.modal = document.createElement("dialog");
    this.modal.className = "product-dialog";
    this.modal.setAttribute("aria-labelledby", "product-dialog-title");
    document.body.append(this.modal);
  }

  open(kind: ViewKind, title: string, description: string): HTMLElement {
    this.modal.replaceChildren();
    this.modal.dataset.view = kind;
    const header = document.createElement("header");
    header.className = "product-dialog-header";
    const copy = document.createElement("div");
    const heading = document.createElement("h2");
    heading.id = "product-dialog-title";
    heading.textContent = title;
    const subtitle = document.createElement("p");
    subtitle.textContent = description;
    copy.append(heading, subtitle);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "icon-button";
    close.setAttribute("aria-label", "关闭弹窗");
    close.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>`;
    close.onclick = () => this.close();
    header.append(copy, close);
    const body = document.createElement("div");
    body.className = "product-dialog-body";
    body.setAttribute("aria-busy", "true");
    const loading = document.createElement("p");
    loading.className = "product-loading";
    loading.textContent = "正在读取…";
    body.append(loading);
    this.modal.append(header, body);
    if (!this.modal.open) this.modal.showModal();
    return body;
  }

  close(): void { this.modal.close(); }
  active(body: HTMLElement): boolean { return this.modal.open && this.modal.contains(body); }

  ready(body: HTMLElement): void {
    body.querySelector(".product-loading")?.remove();
    body.setAttribute("aria-busy", "false");
  }

  feedback(body: HTMLElement, value: unknown, success = false): void {
    if (!this.active(body)) return;
    this.ready(body);
    let message = body.querySelector<HTMLParagraphElement>(".product-feedback");
    if (!message) {
      message = document.createElement("p");
      message.className = "product-feedback";
      body.append(message);
    }
    message.dataset.kind = success ? "success" : "error";
    message.setAttribute("role", success ? "status" : "alert");
    message.textContent = errorText(value);
  }
}
