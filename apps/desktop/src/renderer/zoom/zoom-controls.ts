import "./zoom-controls.css";

type ZoomAction = "in" | "out" | "reset";

const HEADERS = ".task-header, .right-header, .browser-toolbar, .editor-tabs, .editor-breadcrumbs";

function zoomAction(event: KeyboardEvent): ZoomAction | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return null;
  if (event.key === "=" || event.key === "+" || event.code === "NumpadAdd") return "in";
  if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") return "out";
  if (!event.shiftKey && (event.key === "0" || event.code === "Numpad0")) return "reset";
  return null;
}

class ZoomControls {
  private readonly panel = document.createElement("div");
  private readonly level: HTMLOutputElement;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private wheelZoomAt = 0;

  constructor(private readonly reportError: (error: unknown) => void) {
    this.panel.className = "zoom-controls";
    this.panel.popover = "manual";
    this.panel.hidden = true;
    this.panel.setAttribute("role", "group");
    this.panel.setAttribute("aria-label", "界面缩放");
    this.panel.innerHTML = `
      <output class="zoom-level" aria-live="polite" aria-atomic="true" aria-label="当前缩放比例">100%</output>
      <button type="button" data-zoom-action="out" aria-label="缩小界面" title="缩小（Ctrl+-）">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>
      </button>
      <button type="button" data-zoom-action="in" aria-label="放大界面" title="放大（Ctrl++）">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M12 6v12"/></svg>
      </button>
      <span class="zoom-divider" aria-hidden="true"></span>
      <button type="button" data-zoom-action="reset" title="恢复到 100%（Ctrl+0）">重置</button>`;
    this.level = this.panel.querySelector<HTMLOutputElement>(".zoom-level")!;
    document.body.append(this.panel);
    this.bindEvents();
  }

  private bindEvents(): void {
    for (const action of ["out", "in", "reset"] as const) {
      this.panel.querySelector<HTMLButtonElement>(`[data-zoom-action="${action}"]`)!
        .addEventListener("click", () => void this.change(action));
    }
    this.panel.addEventListener("pointerenter", () => clearTimeout(this.hideTimer));
    this.panel.addEventListener("pointerleave", () => this.scheduleHide());
    this.panel.addEventListener("focusin", () => clearTimeout(this.hideTimer));
    this.panel.addEventListener("focusout", () => queueMicrotask(() => this.scheduleHide()));
    const resize = new ResizeObserver(() => this.position());
    document.querySelectorAll(HEADERS + ", .window-titlebar, .terminal-header").forEach(header => resize.observe(header));
    document.addEventListener("keydown", event => this.key(event));
    document.addEventListener("wheel", event => this.wheel(event), { passive: false });
  }

  private key(event: KeyboardEvent): void {
    const action = zoomAction(event);
    if (!action) return;
    event.preventDefault();
    void this.change(action);
  }

  private wheel(event: WheelEvent): void {
    if (!event.ctrlKey || event.deltaY === 0) return;
    event.preventDefault();
    if (event.timeStamp - this.wheelZoomAt < 120) return;
    this.wheelZoomAt = event.timeStamp;
    void this.change(event.deltaY < 0 ? "in" : "out");
  }

  private async change(action: ZoomAction): Promise<void> {
    try {
      const factor = await window.bitAgent.setZoom(action);
      this.level.value = `${Math.round(factor * 100)}%`;
      this.panel.hidden = false;
      if (!this.panel.matches(":popover-open")) this.panel.showPopover();
      this.position();
      this.scheduleHide();
    } catch (error) { this.reportError(error); }
  }

  private position(): void {
    if (this.panel.hidden) return;
    const floating = this.panel.getBoundingClientRect();
    let bottom = document.querySelector(".window-titlebar")!.getBoundingClientRect().bottom;
    for (const header of document.querySelectorAll<HTMLElement>(HEADERS)) {
      const rect = header.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && getComputedStyle(header).visibility !== "hidden"
        && rect.left < floating.right && rect.right > floating.left) {
        bottom = Math.max(bottom, rect.bottom);
      }
    }
    for (const header of document.querySelectorAll<HTMLElement>(".terminal-header")) {
      const rect = header.getBoundingClientRect();
      const top = bottom + 12;
      if (rect.width > 0 && rect.height > 0 && getComputedStyle(header).visibility !== "hidden"
        && rect.left < floating.right && rect.right > floating.left
        && top < rect.bottom && top + floating.height > rect.top) {
        bottom = Math.max(bottom, rect.bottom);
      }
    }
    const top = Math.min(bottom + 12, window.innerHeight - floating.height - 8);
    this.panel.style.top = `${Math.max(bottom + 4, top)}px`;
  }

  private scheduleHide(): void {
    clearTimeout(this.hideTimer);
    if (this.panel.matches(":hover, :focus-within")) return;
    this.hideTimer = setTimeout(() => {
      this.panel.hidePopover();
      this.panel.hidden = true;
    }, 3000);
  }
}

export function mountDesktopZoom(reportError: (error: unknown) => void): void {
  new ZoomControls(reportError);
}
