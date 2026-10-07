import type { BrowserState } from "../../shared/contracts.js";
import { mountDownloads } from "./browser-downloads.js";
import { browserElements } from "./browser-elements.js";
import { BrowserFind } from "./browser-find.js";
import { recordVisit, toggleBookmark } from "./browser-history.js";
import { browserMarkup } from "./browser-markup.js";
import { BrowserNavigation } from "./browser-navigation.js";
import type { BrowserPaneController, BrowserPaneOptions } from "./browser-pane-types.js";
import { mountPrompts } from "./browser-prompts.js";
import { renderBrowserPane } from "./browser-render.js";
import { BrowserSession } from "./browser-session.js";
import { mountBrowserShortcuts, type PaneShortcut } from "./browser-shortcuts.js";
import { renderBrowserStart } from "./browser-start.js";
import { BrowserView } from "./browser-view.js";
import { BrowserWidth } from "./browser-width.js";

export class BrowserPane implements BrowserPaneController {
  private state: BrowserState = { tabs: [], activeId: null, url: "", title: "", loading: false,
    canGoBack: false, canGoForward: false, zoom: 1, error: null, fullscreen: false };
  private opened = false;
  private readonly ui;
  private readonly find: BrowserFind;
  private readonly view: BrowserView;
  private readonly session: BrowserSession;
  private readonly reportError = (error: unknown): void => {
    this.ui.address.setCustomValidity(error instanceof Error ? error.message : String(error));
    this.ui.address.reportValidity();
  };
  private readonly go = (url: string): void => { void this.navigate(url).catch(this.reportError); };
  private readonly tabActions = {
    select: (id: string) => this.selectTab(id),
    close: (id: string) => { void window.bitAgent.closeBrowserTab(id).catch(this.reportError); },
  };

  constructor(private readonly options: BrowserPaneOptions) {
    options.pane.innerHTML = browserMarkup;
    this.ui = browserElements(options.pane);
    this.find = new BrowserFind(options.pane, () => this.hasPage(), this.reportError);
    this.view = new BrowserView({ stage: this.ui.stage, snapshot: this.ui.snapshot,
      isOpen: () => this.opened, hasPage: () => this.hasPage(), reportError: this.reportError });
    this.session = new BrowserSession(() => this.state, (state) => this.update(state));
    new BrowserWidth(options.pane, (resizing) => this.view.setResizing(resizing));
    new BrowserNavigation(this.ui, () => this.state, this.go, this.reportError);
    mountDownloads(this.ui.get(".browser-downloads"));
    mountPrompts(this.ui.get(".browser-prompt"));
    this.bind();
    options.pane.hidden = true;
    this.render();
  }

  open(url?: string): void { void this.setOpen(true, url).catch(this.reportError); }
  openInNewTab(url: string): void { void this.setOpen(true, url, true).catch(this.reportError); }
  close(): void { void this.setOpen(false).catch(this.reportError); }
  toggle(): void { void this.setOpen(!this.opened).catch(this.reportError); }
  isOpen(): boolean { return this.opened; }
  private hasPage(): boolean { return Boolean(this.state.url) && !this.state.error; }

  private bind(): void {
    this.bindToolbar();
    this.bindFailure();
    this.ui.star.addEventListener("click", () => this.toggleStar());
    this.ui.zoom.addEventListener("click", () => this.action("zoom-reset"));
    this.ui.get(".browser-new-tab").addEventListener("click", () => void this.newTab());
    this.ui.get(".browser-start-address").addEventListener("click", () => this.focusAddress());
    this.options.toggle.addEventListener("click", () => this.toggle());
    mountBrowserShortcuts(this.options.pane, (name) => this.shortcut(name));
    window.bitAgent.onBrowserState((state) => this.update(state));
    window.bitAgent.onBrowserReveal(() => { if (!this.opened) this.open(); });
  }

  private bindToolbar(): void {
    const { button } = this.ui;
    button("back").addEventListener("click", () => this.action("back"));
    button("forward").addEventListener("click", () => this.action("forward"));
    button("reload").addEventListener("click", () => {
      if (this.state.error) this.go(this.state.error.url || this.state.url);
      else this.action(this.state.loading ? "stop" : "reload");
    });
    button("external").addEventListener("click", () => this.action("external"));
    button("devtools").addEventListener("click", () => this.action("devtools"));
    button("close").addEventListener("click", () => this.close());
  }

  private bindFailure(): void {
    this.ui.get(".browser-error [data-retry]").addEventListener("click", () => {
      if (this.state.error) this.go(this.state.error.url);
    });
    this.ui.get(".browser-error [data-external]").addEventListener("click", () => {
      if (this.state.error?.url) window.open(this.state.error.url, "_blank", "noopener");
    });
    this.ui.get(".browser-error [data-proceed]").addEventListener("click", () => {
      void window.bitAgent.trustBrowserCertificate().catch(this.reportError);
    });
  }

  private action(action: Parameters<typeof window.bitAgent.browserAction>[0]): void {
    void window.bitAgent.browserAction(action).catch(this.reportError);
  }

  private render(): void {
    renderBrowserPane(this.ui, this.state, this.tabActions);
    this.view.sync();
  }

  private renderStart(): void { renderBrowserStart(this.ui.start, this.go); }

  private update(next: BrowserState): void {
    const finished = this.state.loading && !next.loading && this.state.activeId === next.activeId;
    const switched = this.state.activeId !== next.activeId;
    this.state = next;
    if (switched && !next.url && this.opened) this.renderStart();
    this.render();
    this.session.save();
    if (finished && next.url && !next.error) recordVisit(next.url, next.title);
  }

  private async navigate(url: string): Promise<void> {
    this.ui.address.blur();
    this.state = { ...this.state, error: null, url: this.state.url || url, loading: true };
    this.render();
    await window.bitAgent.navigateBrowser(url);
  }

  private async newTab(url?: string): Promise<void> {
    this.find.close();
    try { await window.bitAgent.newBrowserTab(url); }
    catch (error) { this.reportError(error); return; }
    if (!url) { this.focusAddress(); this.renderStart(); }
  }

  private selectTab(id: string): void {
    if (id === this.state.activeId) return;
    this.find.close();
    void window.bitAgent.selectBrowserTab(id).catch(this.reportError);
  }

  private cycleTab(step: number): void {
    const index = this.state.tabs.findIndex((tab) => tab.id === this.state.activeId);
    if (this.state.tabs.length < 2 || index < 0) return;
    this.selectTab(this.state.tabs[(index + step + this.state.tabs.length) % this.state.tabs.length]!.id);
  }

  private toggleStar(): void {
    if (!this.hasPage()) return;
    toggleBookmark(this.state.url, this.state.title);
    this.render();
  }

  private focusAddress(): void { this.ui.address.focus(); this.ui.address.select(); }

  private shortcut(name: PaneShortcut): void {
    if (name === "focus-address") this.focusAddress();
    else if (name === "find") this.find.open();
    else if (name === "new-tab") void this.newTab();
    else if (name === "close-tab") { if (this.state.activeId) this.tabActions.close(this.state.activeId); }
    else if (name === "next-tab") this.cycleTab(1);
    else if (name === "previous-tab") this.cycleTab(-1);
    else if (name === "bookmark") this.toggleStar();
    else if (name === "zoom-in" || name === "zoom-out" || name === "zoom-reset" || name === "print") {
      if (this.hasPage()) this.action(name);
    } else this.options.onShortcut(name);
  }

  private async setOpen(next: boolean, url?: string, inNewTab = false): Promise<void> {
    const opening = next && !this.opened;
    this.opened = next;
    this.options.pane.hidden = !next;
    this.options.shell.dataset.browserOpen = String(next);
    this.options.toggle.setAttribute("aria-expanded", String(next));
    this.options.toggle.classList.toggle("is-active", next);
    if (!next) { this.find.close(); this.view.sync(); return; }
    this.render();
    if (opening) await this.session.restore();
    if (url) {
      if (inNewTab && this.state.url) await this.newTab(url);
      else this.go(url);
    } else if (opening && !this.state.url && !this.state.error) {
      this.renderStart();
      this.focusAddress();
    }
  }
}
