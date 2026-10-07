const WIDTH_KEY = "bit-agent.browser-width.v1";
const MIN_WIDTH = 360;
const MAIN_MIN_WIDTH = 420;

/** 暂时收窄面板时保留用户选择的宽度，窗口恢复后重新应用。 */
export class BrowserWidth {
  private preferred = 0;
  private readonly handle: HTMLElement;

  constructor(private readonly pane: HTMLElement, private readonly resizing: (value: boolean) => void) {
    this.handle = pane.querySelector(".browser-resize")!;
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    this.apply(Number.isFinite(stored) && stored > 0 ? stored : Math.round(window.innerWidth * 0.42));
    this.handle.addEventListener("pointerdown", (event) => this.startDrag(event));
    this.handle.addEventListener("keydown", (event) => this.keydown(event));
    window.addEventListener("resize", () => this.apply(this.preferred, false));
  }

  private apply(width: number, remember = true): number {
    if (remember) this.preferred = width;
    const sidebar = document.querySelector(".sidebar-left")?.getBoundingClientRect().width ?? 260;
    const available = Math.max(MIN_WIDTH, window.innerWidth - sidebar - MAIN_MIN_WIDTH);
    const clamped = Math.round(Math.min(Math.max(MIN_WIDTH, width), available));
    document.documentElement.style.setProperty("--browser-width", `${clamped}px`);
    document.documentElement.style.setProperty("--tools-width", `${clamped}px`);
    return clamped;
  }

  private startDrag(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    this.handle.setPointerCapture(event.pointerId);
    this.resizing(true);
    document.body.dataset.resizing = "true";
    const move = (next: PointerEvent) => this.apply(window.innerWidth - next.clientX);
    this.handle.addEventListener("pointermove", move);
    this.handle.addEventListener("lostpointercapture", () => this.stopDrag(move), { once: true });
  }

  private stopDrag(move: (event: PointerEvent) => void): void {
    this.handle.removeEventListener("pointermove", move);
    this.resizing(false);
    delete document.body.dataset.resizing;
    this.store(Math.round(this.pane.getBoundingClientRect().width));
  }

  private keydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 80 : 24;
    const delta = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    this.store(this.apply(this.pane.getBoundingClientRect().width + delta));
  }

  private store(width: number): void {
    try { localStorage.setItem(WIDTH_KEY, String(width)); }
    catch (error) { console.warn("无法保存浏览器宽度", error); }
  }
}
