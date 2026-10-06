import { fitSidebarWidth, sidebarWidthKey, sidebarWidthLimits, storedSidebarWidth } from "./sidebar-width";

class SidebarResize {
  private readonly handle = document.createElement("div");
  private preferred = storedSidebarWidth(localStorage.getItem(sidebarWidthKey));
  private pointer: number | null = null;
  private startX = 0;
  private startWidth = 0;

  constructor(private readonly shell: HTMLElement, private readonly sidebar: HTMLElement) {
    this.handle.id = "sidebar-resize";
    this.handle.className = "sidebar-resize";
    this.handle.setAttribute("role", "separator");
    this.handle.setAttribute("aria-label", "调整左侧区域宽度");
    this.handle.setAttribute("aria-orientation", "vertical");
    this.handle.setAttribute("aria-controls", "task-sidebar-pane repository-sidebar-pane");
    this.sidebar.append(this.handle);
    this.handle.addEventListener("pointerdown", event => this.start(event));
    window.addEventListener("pointermove", event => this.move(event));
    window.addEventListener("pointerup", event => this.finish(event.pointerId));
    window.addEventListener("pointercancel", event => this.finish(event.pointerId));
    this.handle.addEventListener("pointercancel", event => this.finish(event.pointerId));
    this.handle.addEventListener("lostpointercapture", event => this.finish(event.pointerId));
    this.handle.addEventListener("keydown", event => this.key(event));
    window.addEventListener("blur", () => this.finish(this.pointer));
    window.addEventListener("resize", () => this.refresh());
    new MutationObserver(() => this.refresh()).observe(shell,
      { attributes: true, attributeFilter: ["data-view", "data-inspector-collapsed"] });
    const inspector = shell.querySelector<HTMLElement>(".sidebar-right");
    if (inspector) new ResizeObserver(() => this.refresh()).observe(inspector);
    this.refresh();
  }

  private inspectorReserve(): number {
    if (window.innerWidth <= 1050 || this.shell.dataset.view === "repository"
      || this.shell.dataset.inspectorCollapsed === "true") return 0;
    const preferred = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--inspector-width"));
    return Number.isFinite(preferred) ? Math.min(280, preferred) : 280;
  }

  private refresh(): void {
    if (window.innerWidth <= 720) {
      this.finish(this.pointer);
      document.documentElement.style.removeProperty("--sidebar-width");
      this.handle.tabIndex = -1;
      return;
    }
    this.handle.tabIndex = 0;
    const fallback = window.innerWidth <= 1050 ? 232 : 260;
    const width = fitSidebarWidth(this.preferred ?? fallback, window.innerWidth, this.inspectorReserve());
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
    const limits = sidebarWidthLimits(window.innerWidth, this.inspectorReserve());
    this.handle.setAttribute("aria-valuemin", String(limits.minimum));
    this.handle.setAttribute("aria-valuemax", String(limits.maximum));
    this.handle.setAttribute("aria-valuenow", String(width));
    this.handle.setAttribute("aria-valuetext", `${width} 像素`);
  }

  private start(event: PointerEvent): void {
    if (event.button !== 0 || window.innerWidth <= 720) return;
    event.preventDefault();
    this.pointer = event.pointerId;
    this.startX = event.clientX;
    this.startWidth = this.sidebar.getBoundingClientRect().width;
    this.handle.setPointerCapture(event.pointerId);
    this.handle.focus();
    document.body.dataset.sidebarResizing = "true";
  }

  private move(event: PointerEvent): void {
    if (event.pointerId !== this.pointer) return;
    this.preferred = fitSidebarWidth(this.startWidth + event.clientX - this.startX,
      window.innerWidth, this.inspectorReserve());
    this.refresh();
  }

  private finish(pointer: number | null): void {
    if (pointer === null || pointer !== this.pointer) return;
    this.pointer = null;
    delete document.body.dataset.sidebarResizing;
    if (this.handle.hasPointerCapture(pointer)) this.handle.releasePointerCapture(pointer);
    if (this.preferred !== null) localStorage.setItem(sidebarWidthKey, String(this.preferred));
  }

  private key(event: KeyboardEvent): void {
    const limits = sidebarWidthLimits(window.innerWidth, this.inspectorReserve());
    const step = event.shiftKey ? 50 : 10;
    const width = this.sidebar.getBoundingClientRect().width;
    const targets: Record<string, number> = { ArrowLeft: width - step, ArrowRight: width + step,
      Home: limits.minimum, End: limits.maximum };
    const target = targets[event.key];
    if (target === undefined || window.innerWidth <= 720) return;
    event.preventDefault();
    this.preferred = fitSidebarWidth(target, window.innerWidth, this.inspectorReserve());
    this.refresh();
    localStorage.setItem(sidebarWidthKey, String(this.preferred));
  }
}

export function mountSidebarResize(shell: HTMLElement): void {
  const sidebar = shell.querySelector<HTMLElement>(".sidebar-left");
  if (sidebar) new SidebarResize(shell, sidebar);
}
