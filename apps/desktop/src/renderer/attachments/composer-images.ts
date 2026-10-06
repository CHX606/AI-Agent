import { normalizeImages, type ImageAttachment } from "../../shared/image-input";
import { errorText } from "../dom";
import { pastedImageFiles, readImageFiles } from "./file-input";
import { previewOnClick } from "./image-preview";
import "./attachments.css";

interface ComposerImageOptions {
  changed(): void;
  disabled(): boolean;
}

export class ComposerImages {
  private images: ImageAttachment[] = [];
  private epoch = 0;
  private loading = 0;
  private readonly input = document.createElement("input");
  private readonly upload = document.createElement("button");
  private readonly panel = document.createElement("div");
  private readonly list = document.createElement("div");
  private readonly error = document.createElement("p");
  private readonly progress = document.createElement("p");

  constructor(card: HTMLElement, private readonly textarea: HTMLTextAreaElement, actions: HTMLElement,
    private readonly options: ComposerImageOptions) {
    this.input.type = "file";
    this.input.accept = "image/png,image/jpeg,image/webp,image/gif";
    this.input.multiple = true;
    this.input.hidden = true;
    this.upload.type = "button";
    this.upload.className = "image-upload";
    this.upload.setAttribute("aria-label", "上传图片");
    this.upload.title = "上传图片（也可 Ctrl+V 粘贴截图）";
    this.upload.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 3-3 5 5"/></svg>';
    this.panel.className = "composer-images";
    this.list.className = "composer-image-list";
    this.error.className = "composer-image-error";
    this.error.setAttribute("role", "alert");
    this.progress.className = "composer-image-progress";
    this.progress.setAttribute("role", "status");
    this.progress.textContent = "正在读取图片…";
    this.panel.append(this.list, this.progress, this.error, this.input);
    card.prepend(this.panel);
    actions.prepend(this.upload);
    this.upload.addEventListener("click", () => this.input.click());
    this.input.addEventListener("change", () => {
      void this.add([...this.input.files ?? []]);
      this.input.value = "";
    });
    this.textarea.addEventListener("paste", event => this.paste(event));
    this.render();
  }

  snapshot(): ImageAttachment[] { return this.images.map(image => ({ ...image })); }
  isReading(): boolean { return this.loading > 0; }

  set(images: ImageAttachment[]): void {
    this.epoch += 1;
    this.images = normalizeImages(images);
    this.loading = 0;
    this.error.textContent = "";
    this.render();
    this.options.changed();
  }

  clear(): void { this.set([]); }

  refresh(): void {
    this.upload.disabled = this.options.disabled();
    for (const button of this.list.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = this.options.disabled();
    }
  }

  private paste(event: ClipboardEvent): void {
    const files = pastedImageFiles(event.clipboardData);
    if (!files.length || this.options.disabled()) return;
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain");
    if (text) {
      this.textarea.setRangeText(text, this.textarea.selectionStart, this.textarea.selectionEnd, "end");
      this.textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    void this.add(files);
  }

  private async add(files: File[]): Promise<void> {
    if (!files.length || this.options.disabled()) return;
    const epoch = this.epoch;
    this.loading += 1;
    this.error.textContent = "";
    this.render();
    this.options.changed();
    try {
      const images = await readImageFiles(files);
      if (epoch !== this.epoch) return;
      this.images = normalizeImages([...this.images, ...images]);
    } catch (error) {
      if (epoch === this.epoch) this.error.textContent = errorText(error);
    } finally {
      if (epoch === this.epoch) {
        this.loading -= 1;
        this.render();
        this.options.changed();
      }
    }
  }

  private thumbnail(image: ImageAttachment, index: number): HTMLElement {
    const figure = document.createElement("figure");
    figure.className = "composer-image";
    const preview = document.createElement("img");
    preview.src = image.data_url;
    preview.alt = image.name;
    previewOnClick(preview, image.name);
    const name = document.createElement("figcaption");
    name.textContent = image.name;
    name.title = image.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `移除图片：${image.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      this.images.splice(index, 1);
      this.error.textContent = "";
      this.render();
      this.options.changed();
    });
    figure.append(preview, name, remove);
    return figure;
  }

  private render(): void {
    this.list.replaceChildren(...this.images.map((image, index) => this.thumbnail(image, index)));
    this.progress.hidden = !this.isReading();
    this.error.hidden = !this.error.textContent;
    this.panel.hidden = !this.images.length && !this.isReading() && this.error.hidden;
    this.refresh();
  }
}
