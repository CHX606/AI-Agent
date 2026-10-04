/**
 * Codex 风格的选择菜单：触发按钮显示当前选项，点开后向上弹出一张卡片，
 * 每项是“图标 + 标题 + 一行说明”，当前项打勾，风险较高的项用琥珀色提示。
 * 对外和原来的下拉框一样：value / disabled 属性，选中后派发 change 事件。
 */
import "./choice-menu.css";

export interface Choice {
  value: string;
  label: string;
  description: string;
  /** SVG 内部的 path 等元素，统一用 24×24 线条图标。 */
  icon: string;
  tone?: "caution";
}

export interface ChoiceMenuOptions {
  /** 菜单卡片顶部的问题，例如“应如何批准 Bit Agent 的操作？” */
  heading: string;
  /** 给读屏软件的名字。 */
  label: string;
  /** 触发按钮里选项前的固定文字，例如“多 Agent”。 */
  prefix?: string;
  choices: Choice[];
  value: string;
}

const svg = (body: string, className: string) =>
  `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const CHEVRON = '<path d="m7 10 5 5 5-5"/>';
const CHECK = '<path d="m5 12 5 5 9-10"/>';

export class ChoiceMenu extends HTMLElement {
  private choices: Choice[] = [];
  private current = "";
  private locked = false;
  private trigger: HTMLButtonElement | null = null;
  private panel: HTMLDivElement | null = null;
  private fixedLabel = "";
  private readonly outside = (event: PointerEvent) => {
    if (!this.contains(event.target as Node)) this.close(false);
  };

  configure(options: ChoiceMenuOptions): void {
    this.choices = options.choices;
    this.fixedLabel = options.prefix ?? "";
    this.current = options.choices.some((choice) => choice.value === options.value)
      ? options.value : options.choices[0]?.value ?? "";
    this.replaceChildren();
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "choice-trigger";
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-label", options.label);
    trigger.disabled = this.locked;
    const popover = document.createElement("div");
    popover.className = "choice-popover";
    popover.setAttribute("role", "menu");
    popover.setAttribute("aria-label", options.label);
    popover.hidden = true;
    const heading = document.createElement("p");
    heading.className = "choice-heading";
    heading.textContent = options.heading;
    popover.append(heading);
    for (const choice of options.choices) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "choice-item";
      item.setAttribute("role", "menuitemradio");
      item.dataset.value = choice.value;
      if (choice.tone) item.dataset.tone = choice.tone;
      item.innerHTML = `${svg(choice.icon, "choice-icon")}<span class="choice-text"><strong></strong><small></small></span>${svg(CHECK, "choice-check")}`;
      item.querySelector("strong")!.textContent = choice.label;
      item.querySelector("small")!.textContent = choice.description;
      item.addEventListener("click", () => this.choose(choice.value));
      popover.append(item);
    }
    trigger.addEventListener("click", () => (popover.hidden ? this.open() : this.close(true)));
    this.addEventListener("keydown", (event) => this.onKey(event));
    this.append(trigger, popover);
    this.trigger = trigger;
    this.panel = popover;
    this.paint();
  }

  get value(): string { return this.current; }

  set value(next: string) {
    if (!this.choices.some((choice) => choice.value === next)) return;
    this.current = next;
    this.paint();
  }

  get disabled(): boolean { return this.locked; }

  set disabled(next: boolean) {
    this.locked = next;
    if (this.trigger) this.trigger.disabled = next;
    if (next) this.close(false);
  }

  private paint(): void {
    const choice = this.choices.find((item) => item.value === this.current);
    if (!this.trigger || !this.panel || !choice) return;
    const prefix = this.fixedLabel ? `<span class="choice-prefix">${this.fixedLabel}</span>` : svg(choice.icon, "choice-icon");
    this.trigger.innerHTML = `${prefix}<span class="choice-value"></span>${svg(CHEVRON, "choice-chevron")}`;
    this.trigger.querySelector(".choice-value")!.textContent = choice.label;
    if (choice.tone) this.trigger.dataset.tone = choice.tone;
    else delete this.trigger.dataset.tone;
    this.title = choice.description;
    for (const item of this.panel.querySelectorAll<HTMLButtonElement>(".choice-item")) {
      item.setAttribute("aria-checked", String(item.dataset.value === this.current));
    }
  }

  private items(): HTMLButtonElement[] {
    return [...(this.panel?.querySelectorAll<HTMLButtonElement>(".choice-item") ?? [])];
  }

  private open(): void {
    if (!this.panel || !this.trigger || this.locked) return;
    this.panel.hidden = false;
    this.trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", this.outside, true);
    (this.items().find((item) => item.dataset.value === this.current) ?? this.items()[0])?.focus();
  }

  private close(restoreFocus: boolean): void {
    if (!this.panel || this.panel.hidden) return;
    this.panel.hidden = true;
    this.trigger?.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this.outside, true);
    if (restoreFocus) this.trigger?.focus();
  }

  private choose(value: string): void {
    const changed = value !== this.current;
    this.value = value;
    this.close(true);
    if (changed) this.dispatchEvent(new Event("change", { bubbles: true }));
  }

  private onKey(event: KeyboardEvent): void {
    if (!this.panel || this.panel.hidden) return;
    const items = this.items();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      // 只关菜单，不能冒泡到全局的“Esc 暂停”。
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Tab") {
      this.close(false);
    }
  }
}

if (!customElements.get("choice-menu")) customElements.define("choice-menu", ChoiceMenu);

declare global {
  interface HTMLElementTagNameMap { "choice-menu": ChoiceMenu }
}

/** 线条图标（24×24），菜单和触发按钮共用。 */
export const icons = {
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  sparkle: '<path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8Z"/><path d="M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8Z"/>',
};
