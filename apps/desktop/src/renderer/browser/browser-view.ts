/** 原生网页视图对齐与遮挡管理：弹层和拖动期间先截图，再让出鼠标事件。 */
import type { BrowserBounds } from "../../shared/contracts.js";

const OVERLAYS = "dialog[open], .choice-popover:not([hidden]), #profile-menu:not([hidden]), .browser-suggestions:not([hidden]), .zoom-controls:not([hidden])";
interface ViewOptions {
  stage: HTMLElement;
  snapshot: HTMLImageElement;
  isOpen(): boolean;
  hasPage(): boolean;
  reportError(error: unknown): void;
}

export class BrowserView {
  private shown = false;
  private resizing = false;
  private lastBounds = "";
  private syncing: Promise<void> = Promise.resolve();

  constructor(private readonly options: ViewOptions) {
    new ResizeObserver(() => { this.follow(); this.sync(); }).observe(options.stage);
    window.addEventListener("resize", () => this.follow());
    new MutationObserver(() => this.sync()).observe(document.body, {
      subtree: true, attributes: true, attributeFilter: ["open", "hidden", "data-view", "data-resizing"],
    });
  }

  setResizing(resizing: boolean): void { this.resizing = resizing; this.sync(); }

  sync(): void {
    this.syncing = this.syncing.then(() => this.reconcile()).catch((error: unknown) => {
      this.shown = false;
      this.options.reportError(error);
    });
  }

  private bounds(): BrowserBounds {
    const rect = this.options.stage.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }

  private occluded(): boolean {
    const rect = this.options.stage.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>(OVERLAYS)].some((element) => {
      if (element.tagName === "DIALOG") return true;
      const other = element.getBoundingClientRect();
      return other.width > 0 && other.left < rect.right && other.right > rect.left && other.top < rect.bottom && other.bottom > rect.top;
    });
  }

  private wanted(): boolean {
    return this.options.isOpen() && !this.resizing && document.body.dataset.resizing !== "true" && this.options.hasPage() && !this.occluded()
      && this.options.stage.getBoundingClientRect().width > 0;
  }

  private async reconcile(): Promise<void> {
    const show = this.wanted();
    if (show && !this.shown) {
      this.lastBounds = JSON.stringify(this.bounds());
      await window.bitAgent.showBrowser(this.bounds());
      this.shown = true;
      setTimeout(() => { if (this.shown) this.options.snapshot.hidden = true; }, 60);
    } else if (!show && this.shown) {
      const keepPicture = this.options.isOpen() && this.options.hasPage();
      const picture = await window.bitAgent.hideBrowser(keepPicture);
      this.shown = false;
      this.options.snapshot.hidden = !(picture && keepPicture);
      if (picture && keepPicture) this.options.snapshot.src = picture;
    }
  }

  private follow(): void {
    if (!this.shown) return;
    const next = JSON.stringify(this.bounds());
    if (next === this.lastBounds) return;
    this.lastBounds = next;
    window.bitAgent.setBrowserBounds(this.bounds());
  }
}
