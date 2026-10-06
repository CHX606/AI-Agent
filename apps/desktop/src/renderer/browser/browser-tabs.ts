/** 浏览器标签栏：网站图标（加载中显示转圈）、标题、关闭按钮；中键关闭。 */
import { displayAddress } from "../../shared/browser-address.js";
import type { BrowserTab } from "../../shared/contracts.js";
import { closeIcon, globeIcon } from "./browser-markup.js";

export function tabTitle(tab: BrowserTab): string {
  return tab.title || (tab.url ? displayAddress(tab.url) : "新标签页");
}

export function renderTabs(container: HTMLElement, tabs: BrowserTab[], activeId: string | null, actions: {
  select(id: string): void;
  close(id: string): void;
}): void {
  const existing = new Map([...container.querySelectorAll<HTMLElement>(".browser-tab")].map((element) => [element.dataset.id!, element]));
  const elements = tabs.map((tab) => {
    let element = existing.get(tab.id);
    existing.delete(tab.id);
    if (!element) {
      element = document.createElement("div");
      element.className = "browser-tab";
      element.dataset.id = tab.id;
      element.setAttribute("role", "tab");
      element.tabIndex = -1;
      element.innerHTML = `<span class="browser-tab-icon"></span><span class="browser-tab-title"></span>
        <button type="button" class="browser-tab-close" aria-label="关闭标签页" title="关闭标签页（Ctrl+W）">${closeIcon}</button>`;
      element.addEventListener("click", (event) => {
        if (!(event.target as Element).closest(".browser-tab-close")) actions.select(tab.id);
      });
      element.addEventListener("auxclick", (event) => { if (event.button === 1) { event.preventDefault(); actions.close(tab.id); } });
      element.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); actions.select(tab.id); }
      });
      element.querySelector(".browser-tab-close")!.addEventListener("click", () => actions.close(tab.id));
    }
    const title = tabTitle(tab);
    element.querySelector(".browser-tab-title")!.textContent = title;
    element.title = tab.url ? `${title}\n${tab.url}` : title;
    element.setAttribute("aria-selected", String(tab.id === activeId));
    element.tabIndex = tab.id === activeId ? 0 : -1;
    const iconSlot = element.querySelector<HTMLElement>(".browser-tab-icon")!;
    const iconKey = tab.loading ? "loading" : tab.favicon ?? "";
    if (iconSlot.dataset.key !== iconKey) {
      iconSlot.dataset.key = iconKey;
      if (tab.loading) iconSlot.innerHTML = `<span class="browser-spinner"></span>`;
      else if (tab.favicon) {
        const image = document.createElement("img");
        image.alt = "";
        image.src = tab.favicon;
        // 图标加载失败时退回地球图标。
        image.addEventListener("error", () => { iconSlot.innerHTML = globeIcon; }, { once: true });
        iconSlot.replaceChildren(image);
      } else iconSlot.innerHTML = globeIcon;
    }
    return element;
  });
  for (const stale of existing.values()) stale.remove();
  elements.forEach((element, index) => {
    if (container.children[index] !== element) container.insertBefore(element, container.children[index] ?? null);
  });
  container.querySelector<HTMLElement>(`.browser-tab[aria-selected="true"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
