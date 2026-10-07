import type { TerminalPosition } from "./terminal-position.js";

const HEIGHT_KEY = "bit-agent.terminal-height.v1";
const WIDTH_KEY = "bit-agent.terminal-width.v1";

interface LayoutOptions {
  panel: HTMLElement;
  shell: HTMLElement;
  homes: { tasks: HTMLElement; repository: HTMLElement; right: HTMLElement };
  resized(): void;
}

/** 位置与尺寸只移动面板，不重新创建终端会话。 */
export class TerminalSizing {
  private position: TerminalPosition = "right";
  private readonly handle: HTMLElement;
  private width: number;
  private height: number;

  constructor(private readonly options: LayoutOptions) {
    this.handle = options.panel.querySelector<HTMLElement>(".terminal-resize")!;
    this.width = this.savedSize(WIDTH_KEY, 420);
    this.height = this.savedSize(HEIGHT_KEY, 260);
    this.handle.addEventListener("pointerdown", (event) => this.drag(event));
    this.handle.addEventListener("keydown", (event) => this.resizeByKey(event));
    window.addEventListener("resize", () => this.applySize());
    new MutationObserver(() => this.relocate()).observe(options.shell,
      { attributes: true, attributeFilter: ["data-view"] });
  }

  private savedSize(key: string, fallback: number): number {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  setPosition(position: TerminalPosition): void {
    this.position = position;
    this.options.panel.dataset.position = position;
    this.options.shell.dataset.terminalPosition = position;
    const right = position === "right";
    this.handle.setAttribute("aria-orientation", right ? "vertical" : "horizontal");
    this.handle.setAttribute("aria-label", right ? "调整终端宽度" : "调整终端高度");
    this.relocate();
  }

  relocate(): void {
    const { panel, shell, homes } = this.options;
    const home = this.position === "right" ? homes.right : shell.dataset.view === "repository" ? homes.repository : homes.tasks;
    if (panel.parentElement !== home) home.insertBefore(panel, home.querySelector(":scope > .editor-status"));
    this.applySize();
    this.options.resized();
  }

  private applySize(): void {
    if (this.position === "right") this.applyWidth(this.width);
    else this.applyHeight(this.height);
  }

  private applyWidth(width: number): number {
    const sidebar = this.options.shell.querySelector(".sidebar-left")?.getBoundingClientRect().width ?? 260;
    const maximum = window.innerWidth <= 1050 ? window.innerWidth * 0.88 : window.innerWidth - sidebar - 420;
    const clamped = Math.round(Math.min(Math.max(320, width), Math.max(320, maximum)));
    document.documentElement.style.setProperty("--terminal-width", `${clamped}px`);
    document.documentElement.style.setProperty("--tools-width", `${clamped}px`);
    return clamped;
  }

  private applyHeight(height: number): number {
    const container = this.options.panel.parentElement?.clientHeight ?? window.innerHeight;
    const clamped = Math.round(Math.min(Math.max(120, height), Math.max(120, container - 240)));
    this.options.panel.style.setProperty("--terminal-height", `${clamped}px`);
    document.documentElement.style.setProperty("--terminal-bottom-size", `${clamped}px`);
    return clamped;
  }

  private rememberSize(value: number): void {
    const right = this.position === "right";
    if (right) this.width = value;
    else this.height = value;
    localStorage.setItem(right ? WIDTH_KEY : HEIGHT_KEY, String(value));
  }

  private drag(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    this.handle.setPointerCapture(event.pointerId);
    const right = this.position === "right";
    const start = right ? event.clientX : event.clientY;
    const box = this.options.panel.getBoundingClientRect();
    const size = right ? box.width : box.height;
    let next = size;
    document.body.dataset.resizing = "true";
    const move = (pointer: PointerEvent) => {
      const value = size + start - (right ? pointer.clientX : pointer.clientY);
      next = right ? this.applyWidth(value) : this.applyHeight(value);
    };
    this.handle.addEventListener("pointermove", move);
    this.handle.addEventListener("lostpointercapture", () => {
      this.handle.removeEventListener("pointermove", move);
      delete document.body.dataset.resizing;
      this.rememberSize(next);
    }, { once: true });
  }

  private resizeByKey(event: KeyboardEvent): void {
    const right = this.position === "right";
    const grow = right ? "ArrowLeft" : "ArrowUp";
    const shrink = right ? "ArrowRight" : "ArrowDown";
    const delta = event.key === grow ? 1 : event.key === shrink ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const box = this.options.panel.getBoundingClientRect();
    const value = (right ? box.width : box.height) + delta * (event.shiftKey ? 60 : 20);
    this.rememberSize(right ? this.applyWidth(value) : this.applyHeight(value));
  }
}
