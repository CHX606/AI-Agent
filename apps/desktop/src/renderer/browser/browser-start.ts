/** 起始页复用浏览历史和书签；网址信息在窄面板内省略，完整地址保留在提示中。 */
import { displayAddress } from "../../shared/browser-address.js";
import { bookmarks, recentVisits } from "./browser-history.js";
import { globeIcon } from "./browser-markup.js";

interface StartEntry { url: string; title: string }

function entryButton(item: StartEntry, open: (url: string) => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "browser-recent-item";
  element.title = item.url;
  const icon = document.createElement("span");
  icon.className = "browser-entry-icon";
  icon.innerHTML = globeIcon;
  const copy = document.createElement("span");
  copy.className = "browser-entry-copy";
  const title = document.createElement("strong");
  title.textContent = item.title || displayAddress(item.url);
  const url = document.createElement("span");
  url.textContent = displayAddress(item.url);
  copy.append(title, url);
  element.append(icon, copy);
  element.addEventListener("click", () => open(item.url));
  return element;
}

function renderSection(start: HTMLElement, kind: "bookmarks" | "recent", items: StartEntry[], open: (url: string) => void): void {
  start.querySelector(`.browser-${kind}`)!.replaceChildren(...items.map((item) => entryButton(item, open)));
  start.querySelector<HTMLElement>(`.browser-${kind}-section`)!.hidden = !items.length;
}

export function renderBrowserStart(start: HTMLElement, open: (url: string) => void): void {
  const marked = bookmarks().slice(0, 8);
  const recent = recentVisits(6);
  renderSection(start, "bookmarks", marked, open);
  renderSection(start, "recent", recent, open);
  start.querySelector<HTMLElement>(".browser-start-empty")!.hidden = Boolean(marked.length || recent.length);
}
