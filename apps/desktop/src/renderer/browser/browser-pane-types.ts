import type { BrowserShortcut } from "../../shared/contracts.js";

export interface BrowserPaneController {
  open(url?: string): void;
  openInNewTab(url: string): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

export interface BrowserPaneOptions {
  shell: HTMLElement;
  pane: HTMLElement;
  toggle: HTMLButtonElement;
  onShortcut(shortcut: BrowserShortcut): void;
}
