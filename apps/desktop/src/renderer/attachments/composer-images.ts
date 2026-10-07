import { FILE_LIMITS, attachmentSize, normalizeAttachments, validateUploadLimits, type FileAttachment } from "../../shared/attachment-input";
import { normalizeImages, type ImageAttachment } from "../../shared/image-input";
import { errorText } from "../dom";
import { pastedImageFiles, readImageFiles } from "./file-input";
import { readAttachmentFiles } from "./attachment-file-input";
import { attachmentCard, attachmentDetails } from "./attachment-card";
import { previewOnClick } from "./image-preview";
import "./attachments.css";

interface ComposerImageOptions {
  changed(): void;
  disabled(): boolean;
}

export class ComposerImages {
  private images: ImageAttachment[] = [];
  private attachments: FileAttachment[] = [];
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
    this.input.multiple = true;
    this.input.hidden = true;
    this.upload.type = "button";
    this.upload.className = "image-upload";
    this.upload.setAttribute("aria-label", "上传附件");
    this.upload.title = "上传附件（最多 5 个、合计 20 MiB；Ctrl+V 粘贴截图）";
    this.upload.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    this.panel.className = "composer-images";
    this.list.className = "composer-image-list";
    this.error.className = "composer-image-error";
    this.error.setAttribute("role", "alert");
    this.progress.className = "composer-image-progress";
    this.progress.setAttribute("role", "status");
    this.progress.textContent = "正在读取附件…";
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
  attachmentsSnapshot(): FileAttachment[] { return this.attachments.map(item => ({ ...item })); }
  isReading(): boolean { return this.loading > 0; }

  set(images: ImageAttachment[], attachments: FileAttachment[] = []): void {
    this.epoch += 1;
    const nextImages = normalizeImages(images);
    const nextAttachments = normalizeAttachments(attachments);
    validateUploadLimits(nextImages, nextAttachments);
    this.images = nextImages;
    this.attachments = nextAttachments;
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
      const selected = await this.readFiles(files);
      if (epoch !== this.epoch) return;
      const images = normalizeImages([...this.images, ...selected.images]);
      const attachments = normalizeAttachments([...this.attachments, ...selected.attachments]);
      validateUploadLimits(images, attachments);
      this.images = images;
      this.attachments = attachments;
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

  private async readFiles(files: File[]): Promise<{ images: ImageAttachment[]; attachments: FileAttachment[] }> {
    if (this.images.length + this.attachments.length + files.length > FILE_LIMITS.maxCount) throw new Error("每次最多发送 5 个图片或附件");
    const stored = [...this.images, ...this.attachments].reduce((total, file) => total + attachmentSize(file), 0);
    if (stored + files.reduce((total, file) => total + file.size, 0) > FILE_LIMITS.maxTotalBytes) {
      throw new Error("图片与附件总大小不能超过 20 MiB");
    }
    const pictureFiles = files.filter(file => file.type.startsWith("image/"));
    const documentFiles = files.filter(file => !file.type.startsWith("image/"));
    return { images: await readImageFiles(pictureFiles), attachments: await readAttachmentFiles(documentFiles) };
  }

  private fileCard(file: FileAttachment, index: number): HTMLElement {
    const card = attachmentCard(attachmentDetails(file)!);
    card.classList.add("composer-attachment");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.setAttribute("aria-label", `移除附件：${file.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      this.attachments.splice(index, 1);
      this.error.textContent = "";
      this.render();
      this.options.changed();
    });
    card.append(remove);
    return card;
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
    this.list.replaceChildren(...this.images.map((image, index) => this.thumbnail(image, index)),
      ...this.attachments.map((file, index) => this.fileCard(file, index)));
    this.progress.hidden = !this.isReading();
    this.error.hidden = !this.error.textContent;
    this.panel.hidden = !this.images.length && !this.attachments.length && !this.isReading() && this.error.hidden;
    this.refresh();
  }
}
