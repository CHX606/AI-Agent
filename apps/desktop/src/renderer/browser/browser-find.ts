export class BrowserFind {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly bar: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;

  constructor(pane: HTMLElement, private readonly hasPage: () => boolean, private readonly reportError: (error: unknown) => void) {
    this.bar = pane.querySelector(".browser-find")!;
    this.input = this.bar.querySelector("input")!;
    this.count = this.bar.querySelector(".browser-find-count")!;
    this.input.addEventListener("input", () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(false), 150);
    });
    this.input.addEventListener("keydown", (event) => this.keydown(event));
    this.bar.querySelector("[data-find=previous]")!.addEventListener("click", () => this.run(true, false));
    this.bar.querySelector("[data-find=next]")!.addEventListener("click", () => this.run(true));
    this.bar.querySelector("[data-find=close]")!.addEventListener("click", () => this.close());
  }

  open(): void {
    if (!this.hasPage()) return;
    this.bar.hidden = false;
    this.input.focus();
    this.input.select();
  }

  close(): void {
    if (this.bar.hidden) return;
    clearTimeout(this.timer);
    this.bar.hidden = true;
    this.count.textContent = "";
    window.bitAgent.stopFindInBrowser();
  }

  private run(next: boolean, forward = true): void {
    void window.bitAgent.findInBrowser(this.input.value, { next, forward }).then((result) => {
      this.count.textContent = this.input.value ? (result.matches ? `${result.active}/${result.matches}` : "无结果") : "";
    }).catch(this.reportError);
  }

  private keydown(event: KeyboardEvent): void {
    if (event.key === "Enter") { event.preventDefault(); this.run(true, !event.shiftKey); }
    else if (event.key === "Escape") { event.preventDefault(); this.close(); }
  }
}
