import type { TerminalSession } from "./terminal-session.js";

/** 查找栏只处理查找，当前会话由面板提供。 */
export class TerminalFind {
  private readonly bar: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;

  constructor(panel: HTMLElement, private readonly current: () => TerminalSession | null) {
    this.bar = panel.querySelector<HTMLElement>(".terminal-find")!;
    this.input = this.bar.querySelector<HTMLInputElement>("input")!;
    this.count = this.bar.querySelector<HTMLElement>(".terminal-find-count")!;
    this.input.addEventListener("input", () => this.find());
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); this.find(event.shiftKey); }
      else if (event.key === "Escape") { event.preventDefault(); this.close(); }
    });
    this.bar.querySelector("[data-find=previous]")!.addEventListener("click", () => this.find(true));
    this.bar.querySelector("[data-find=next]")!.addEventListener("click", () => this.find());
    this.bar.querySelector("[data-find=close]")!.addEventListener("click", () => this.close());
  }

  private decorations() {
    const style = getComputedStyle(document.documentElement);
    const brand = style.getPropertyValue("--brand").trim();
    return { matchBackground: style.getPropertyValue("--selection").trim(), activeMatchBackground: brand,
      matchOverviewRuler: brand, activeMatchColorOverviewRuler: brand };
  }

  private find(backward = false): void {
    const session = this.current();
    if (!session) return;
    const term = this.input.value;
    if (!term) { session.search.clearDecorations(); this.count.textContent = ""; return; }
    const options = { decorations: this.decorations(), incremental: !backward };
    const found = backward ? session.search.findPrevious(term, options) : session.search.findNext(term, options);
    if (!found) this.count.textContent = "无结果";
  }

  open(): void {
    const session = this.current();
    if (!session) return;
    this.bar.hidden = false;
    const selection = session.terminal.getSelection();
    if (selection && !selection.includes("\n")) this.input.value = selection;
    this.input.focus();
    this.input.select();
    if (this.input.value) this.find();
  }

  close(): void {
    if (this.bar.hidden) return;
    this.bar.hidden = true;
    this.count.textContent = "";
    this.current()?.search.clearDecorations();
    this.current()?.terminal.clearSelection();
    this.current()?.terminal.focus();
  }

  toggle(): void { if (this.bar.hidden) this.open(); else this.close(); }

  watch(session: TerminalSession): void {
    session.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (session !== this.current() || !this.input.value) return;
      this.count.textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : "无结果";
    });
  }
}
