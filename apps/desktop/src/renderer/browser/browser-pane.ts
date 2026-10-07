import { BrowserPane } from "./browser-pane-controller.js";
import type { BrowserPaneController, BrowserPaneOptions } from "./browser-pane-types.js";
import "./browser.css";

export type { BrowserPaneController } from "./browser-pane-types.js";

export function mountBrowserPane(options: BrowserPaneOptions): BrowserPaneController {
  return new BrowserPane(options);
}
