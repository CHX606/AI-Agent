import type { RendererApp } from "./context.js";
import { element } from "../dom.js";
import { mountBrowserPane, type BrowserPaneController } from "../browser/browser-pane.js";
import { mountTerminalPanel } from "../terminal/terminal-panel.js";

function quoteTerminal(app: RendererApp, text: string): void {
  if (app.activeView !== "tasks") app.setActiveView("tasks");
  const input = app.objectiveInput;
  const block = `\n\`\`\`\n${text}\n\`\`\`\n`;
  const start = input.selectionStart ?? input.value.length;
  input.setRangeText(block, start, input.selectionEnd ?? start, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

function createToolsPane(shell: HTMLElement, browser: HTMLElement): HTMLElement {
  const pane = document.createElement("aside");
  pane.className = "tools-pane";
  pane.setAttribute("aria-label", "浏览器与终端");
  pane.hidden = true;
  shell.append(pane);
  pane.append(browser);
  const update = () => {
    pane.hidden = shell.dataset.browserOpen !== "true"
      && !(shell.dataset.terminalOpen === "true" && shell.dataset.terminalPosition === "right");
  };
  new MutationObserver(update).observe(shell,
    { attributes: true, attributeFilter: ["data-browser-open", "data-terminal-open", "data-terminal-position"] });
  return pane;
}

export function mountToolPanels(app: RendererApp, toggleSidebar: () => void) {
  const browser = element<HTMLElement>("#browser-pane");
  const right = createToolsPane(app.shell, browser);
  let browserPane: BrowserPaneController;
  const terminalPanel = mountTerminalPanel({
    panel: element<HTMLElement>("#terminal-panel"), toggle: element<HTMLButtonElement>("#terminal-toggle"),
    homes: { tasks: element<HTMLElement>(".main-center"), repository: element<HTMLElement>("#repository-view"), right },
    shell: app.shell, workspace: () => app.activeWorkspaceRoot,
    openUrl: (url) => browserPane.openInNewTab(url), quote: (text) => quoteTerminal(app, text),
  });
  browserPane = mountBrowserPane({
    shell: app.shell, pane: browser, toggle: element<HTMLButtonElement>("#browser-toggle"),
    onShortcut: (shortcut) => {
      if (shortcut === "toggle-sidebar") toggleSidebar();
      else if (shortcut === "toggle-terminal") terminalPanel.toggle();
    },
  });
  return { terminalPanel, browserPane };
}
