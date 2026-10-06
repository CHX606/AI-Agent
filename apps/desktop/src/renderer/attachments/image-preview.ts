import "./attachments.css";

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const STEP = 1.25;

/** Full-size image viewer with wheel/keyboard/button zoom and drag-to-pan. Scale is relative to the fitted size. */
class ImagePreview {
  readonly dialog = document.createElement("dialog");
  private readonly image = document.createElement("img");
  private readonly caption = document.createElement("p");
  private readonly level = document.createElement("span");
  private scale = 1;
  private x = 0;
  private y = 0;
  private drag: { id: number; startX: number; startY: number; x: number; y: number; moved: boolean } | null = null;
  private suppressClick = false;

  constructor() {
    this.dialog.className = "image-preview";
    this.dialog.setAttribute("aria-label", "图片预览");
    this.caption.className = "image-preview-name";
    this.image.draggable = false;
    const close = this.button("image-preview-close", "关闭预览",
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>', () => this.dialog.close());
    const toolbar = document.createElement("div");
    toolbar.className = "image-preview-toolbar";
    this.level.className = "image-preview-level";
    this.level.setAttribute("aria-live", "polite");
    toolbar.append(
      this.button("", "缩小", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>', () => this.zoomBy(1 / STEP)),
      this.level,
      this.button("", "放大", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M12 6v12"/></svg>', () => this.zoomBy(STEP)),
      this.button("image-preview-fit", "适应窗口", "适应", () => this.reset()),
    );
    this.dialog.append(close, this.image, this.caption, toolbar);
    // Clicking the backdrop (the dialog itself, outside the image) closes it, unless a drag just ended there.
    this.dialog.addEventListener("click", event => {
      if (this.suppressClick) { this.suppressClick = false; return; }
      if (event.target === this.dialog) this.dialog.close();
    });
    this.dialog.addEventListener("close", () => this.image.removeAttribute("src"));
    this.dialog.addEventListener("wheel", event => {
      event.preventDefault();
      this.zoomBy(Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
    }, { passive: false });
    this.dialog.addEventListener("keydown", event => this.key(event));
    this.image.addEventListener("load", () => this.render());
    this.image.addEventListener("dblclick", event => {
      if (this.scale !== 1) this.reset();
      else this.zoomTo(Math.max(2, this.actualScale()), event.clientX, event.clientY);
    });
    this.image.addEventListener("pointerdown", event => this.startDrag(event));
    this.image.addEventListener("pointermove", event => this.moveDrag(event));
    this.image.addEventListener("pointerup", event => this.endDrag(event));
    this.image.addEventListener("pointercancel", event => this.endDrag(event));
    document.body.append(this.dialog);
  }

  open(src: string, name: string): void {
    this.image.src = src;
    this.image.alt = name;
    this.caption.textContent = name;
    this.reset();
    if (!this.dialog.open) this.dialog.showModal();
  }

  private button(className: string, label: string, content: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    if (className) button.className = className;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = content;
    button.addEventListener("click", action);
    return button;
  }

  private key(event: KeyboardEvent): void {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === "+" || event.key === "=") this.zoomBy(STEP);
    else if (event.key === "-" || event.key === "_") this.zoomBy(1 / STEP);
    else if (event.key === "0") this.reset();
    else return;
    event.preventDefault();
  }

  /** Scale at which one image pixel is one screen pixel. */
  private actualScale(): number {
    const fitted = this.image.offsetWidth;
    return fitted && this.image.naturalWidth ? this.image.naturalWidth / fitted : 1;
  }

  private reset(): void {
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this.render();
  }

  private zoomBy(factor: number, clientX?: number, clientY?: number): void {
    this.zoomTo(this.scale * factor, clientX, clientY);
  }

  /** Zooms keeping the point under (clientX, clientY) fixed; defaults to the image center. */
  private zoomTo(target: number, clientX?: number, clientY?: number): void {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, target));
    if (next === this.scale) return;
    const rect = this.image.getBoundingClientRect();
    // The transform scales around the layout center; the rendered center is that plus the translation.
    const centerX = rect.left + rect.width / 2 - this.x;
    const centerY = rect.top + rect.height / 2 - this.y;
    const px = (clientX ?? rect.left + rect.width / 2) - centerX;
    const py = (clientY ?? rect.top + rect.height / 2) - centerY;
    const ratio = next / this.scale;
    this.x = px - ratio * (px - this.x);
    this.y = py - ratio * (py - this.y);
    this.scale = next;
    if (next <= 1) { this.x = 0; this.y = 0; }
    this.render();
  }

  private startDrag(event: PointerEvent): void {
    if (event.button !== 0 || this.scale <= 1) return;
    event.preventDefault();
    this.image.setPointerCapture(event.pointerId);
    this.drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: this.x, y: this.y, moved: false };
    this.dialog.dataset.dragging = "true";
  }

  private moveDrag(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.id) return;
    const dx = event.clientX - this.drag.startX;
    const dy = event.clientY - this.drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
    this.x = this.drag.x + dx;
    this.y = this.drag.y + dy;
    this.render();
  }

  private endDrag(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.id) return;
    this.suppressClick = this.drag.moved;
    this.drag = null;
    delete this.dialog.dataset.dragging;
  }

  private render(): void {
    this.image.style.transform = this.scale === 1 ? "" : `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    this.dialog.dataset.zoomed = String(this.scale > 1);
    const percent = Math.round(this.scale / this.actualScale() * 100);
    this.level.textContent = Number.isFinite(percent) ? `${percent}%` : "";
    this.dialog.dataset.scale = String(this.scale);
  }
}

let preview: ImagePreview | null = null;

export function openImagePreview(src: string, name: string): void {
  preview ??= new ImagePreview();
  preview.open(src, name);
}

/** Makes a thumbnail open the full-size preview on click or Enter/Space. */
export function previewOnClick(element: HTMLImageElement, name: string): void {
  element.classList.add("previewable-image");
  element.tabIndex = 0;
  element.setAttribute("role", "button");
  element.setAttribute("aria-label", `查看大图：${name}`);
  element.addEventListener("click", () => openImagePreview(element.src, name));
  element.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openImagePreview(element.src, name);
  });
}
