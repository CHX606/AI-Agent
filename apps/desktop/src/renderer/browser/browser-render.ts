import { displayAddress } from "../../shared/browser-address.js";
import { browserErrorMessage } from "../../shared/browser-errors.js";
import type { BrowserState } from "../../shared/contracts.js";
import type { BrowserElements } from "./browser-elements.js";
import { isBookmarked } from "./browser-history.js";
import { renderTabs } from "./browser-tabs.js";

function renderFailure(ui: BrowserElements, error: NonNullable<BrowserState["error"]>): void {
  ui.get(".browser-error-title").textContent = error.code === -1 ? "页面已停止运行" : "无法打开这个网页";
  ui.get(".browser-error-detail").textContent = browserErrorMessage(error.code, error.description);
  ui.get(".browser-error-code").textContent = error.code === -1 ? "" : `${error.description}（${error.code}）`;
  ui.get(".browser-error-url").textContent = error.url;
  ui.get(".browser-error-certificate").hidden = !error.certificate;
  ui.get(".browser-error [data-proceed]").hidden = !error.certificate;
}

function renderBookmark(ui: BrowserElements, state: BrowserState): void {
  const hasPage = Boolean(state.url) && !state.error;
  const marked = hasPage && isBookmarked(state.url);
  ui.star.hidden = !hasPage;
  ui.star.setAttribute("aria-pressed", String(marked));
  ui.star.title = marked ? "移除书签（Ctrl+D）" : "加入书签（Ctrl+D）";
  ui.star.setAttribute("aria-label", marked ? "移除书签" : "加入书签");
}

export function renderBrowserPane(ui: BrowserElements, state: BrowserState, actions: {
  select(id: string): void; close(id: string): void;
}): void {
  renderTabs(ui.tabs, state.tabs, state.activeId, actions);
  ui.start.hidden = Boolean(state.url) || Boolean(state.error);
  ui.failure.hidden = !state.error;
  if (state.error) renderFailure(ui, state.error);
  renderBookmark(ui, state);
  if (document.activeElement !== ui.address) ui.address.value = state.url ? displayAddress(state.url) : "";
  ui.address.title = state.title ? `${state.title}\n${state.url}` : state.url;
  ui.button("back").disabled = !state.canGoBack;
  ui.button("forward").disabled = !state.canGoForward;
  const reload = ui.button("reload");
  reload.dataset.loading = String(state.loading);
  reload.title = state.loading ? "停止" : "重新加载（F5）";
  reload.setAttribute("aria-label", reload.title);
  reload.disabled = !state.url && !state.error;
  ui.button("external").disabled = !state.url;
  ui.button("devtools").disabled = !state.url;
  ui.zoom.hidden = Math.abs(state.zoom - 1) < 0.001;
  ui.zoom.textContent = `${Math.round(state.zoom * 100)}%`;
  ui.progress.dataset.loading = String(state.loading);
  if (!state.url) ui.snapshot.hidden = true;
}
