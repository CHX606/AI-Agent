import { browserAddress, displayAddress } from "../../shared/browser-address.js";
import type { BrowserState } from "../../shared/contracts.js";
import type { BrowserElements } from "./browser-elements.js";
import { mountSuggestions } from "./browser-suggestions.js";

type Suggestions = ReturnType<typeof mountSuggestions>;

export class BrowserNavigation {
  private readonly suggest: Suggestions;

  constructor(private readonly ui: BrowserElements, private readonly current: () => BrowserState,
    private readonly open: (url: string) => void, private readonly reportError: (error: unknown) => void) {
    const { address, form } = ui;
    this.suggest = mountSuggestions({ input: address, list: ui.get(".browser-suggestions"), open });
    form.noValidate = true;
    form.addEventListener("submit", (event) => this.submit(event));
    address.addEventListener("input", () => address.setCustomValidity(""));
    address.addEventListener("focus", () => this.focused());
    address.addEventListener("blur", () => this.restoreAddress());
    address.addEventListener("keydown", (event) => this.keydown(event));
  }

  private submit(event: SubmitEvent): void {
    event.preventDefault();
    this.ui.address.setCustomValidity("");
    const picked = this.suggest.picked();
    this.suggest.close();
    try {
      const url = picked || browserAddress(this.ui.address.value);
      if (url) this.open(url);
    } catch (error) { this.reportError(error); }
  }

  private focused(): void {
    if (this.current().url) this.ui.address.value = this.current().url;
    this.ui.address.select();
  }

  private restoreAddress(): void {
    if (this.current().url) this.ui.address.value = displayAddress(this.current().url);
  }

  private keydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || this.suggest.isOpen()) return;
    this.ui.address.value = this.current().url ? displayAddress(this.current().url) : "";
    this.ui.address.blur();
  }
}
