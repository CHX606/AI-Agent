import type { BrowserShortcut } from "../../shared/contracts.js";

export type PaneShortcut = BrowserShortcut | "zoom-in" | "zoom-out" | "zoom-reset" | "print";
const KEYS: Record<string, PaneShortcut> = {
  f: "find", t: "new-tab", w: "close-tab", l: "focus-address", d: "bookmark",
  "=": "zoom-in", "+": "zoom-in", "-": "zoom-out", "0": "zoom-reset", p: "print",
};

function keyShortcut(event: KeyboardEvent): PaneShortcut | null {
  const key = event.key.toLowerCase();
  if (key === "tab") return event.shiftKey ? "previous-tab" : "next-tab";
  if (event.shiftKey) return key === "+" ? "zoom-in" : null;
  return KEYS[key] ?? null;
}

export function mountBrowserShortcuts(pane: HTMLElement, run: (name: PaneShortcut) => void): void {
  pane.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const name = keyShortcut(event);
    if (!name) return;
    event.preventDefault();
    event.stopPropagation();
    run(name);
  });
  window.bitAgent.onBrowserShortcut(run);
}
