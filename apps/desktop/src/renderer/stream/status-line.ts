import { RunStatus } from "./run-status";
import "./status.css";

export class StreamStatusLine extends RunStatus {
  private readonly line: HTMLElement;
  private readonly glyph: HTMLElement;
  private readonly verb: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly timer: number;

  constructor(line: HTMLElement | undefined, private readonly onVisible: () => void) {
    super();
    this.line = line ?? document.createElement("div");
    if (!line) {
      this.line.hidden = true;
      this.line.innerHTML = '<span class="status-glyph"></span><span class="status-verb"></span><span class="status-meta"></span>';
    }
    this.glyph = this.line.querySelector<HTMLElement>(".status-glyph")!;
    this.verb = this.line.querySelector<HTMLElement>(".status-verb")!;
    this.meta = this.line.querySelector<HTMLElement>(".status-meta")!;
    this.timer = line ? window.setInterval(() => this.animate(), 150) : 0;
    if (this.timer) window.addEventListener("beforeunload", () => this.dispose(), { once: true });
  }

  private animate(): void {
    if (this.line.hidden || this.stopped) return;
    this.tick();
    this.paint();
  }

  paint(): void {
    const result = this.presentation();
    const wasHidden = this.line.hidden;
    this.line.hidden = result.hidden;
    this.line.dataset.state = result.state;
    this.glyph.textContent = result.glyph;
    this.verb.textContent = result.verb;
    this.meta.textContent = result.meta;
    if (wasHidden && !result.hidden) requestAnimationFrame(this.onVisible);
  }

  dispose(): void { if (this.timer) window.clearInterval(this.timer); }
}
