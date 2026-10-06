/** 地址栏下方的建议列表：书签和历史；上下键选择，回车或点击打开，Esc 关闭。 */
import { displayAddress } from "../../shared/browser-address.js";
import { suggestions } from "./browser-history.js";

export function mountSuggestions(options: { input: HTMLInputElement; list: HTMLElement; open(url: string): void }) {
  const { input, list } = options;
  let items: { url: string }[] = [];
  let selected = -1;

  const close = () => {
    list.hidden = true;
    list.replaceChildren();
    items = [];
    selected = -1;
    input.removeAttribute("aria-activedescendant");
  };
  const highlight = (index: number) => {
    selected = index;
    list.querySelectorAll<HTMLElement>(".browser-suggestion").forEach((element, position) => {
      element.setAttribute("aria-selected", String(position === index));
    });
    if (index >= 0) input.setAttribute("aria-activedescendant", `browser-suggestion-${index}`);
    else input.removeAttribute("aria-activedescendant");
  };
  const render = () => {
    const found = suggestions(input.value);
    items = found;
    selected = -1;
    if (!found.length) { close(); return; }
    list.replaceChildren(...found.map((item, index) => {
      const element = document.createElement("li");
      element.id = `browser-suggestion-${index}`;
      element.className = "browser-suggestion";
      element.setAttribute("role", "option");
      element.dataset.kind = item.kind;
      const title = document.createElement("strong");
      title.textContent = item.title;
      const url = document.createElement("span");
      url.textContent = displayAddress(item.url);
      element.append(title, url);
      // 用 mousedown：click 之前输入框会失焦，列表就关掉了。
      element.addEventListener("mousedown", (event) => { event.preventDefault(); close(); options.open(item.url); });
      element.addEventListener("mousemove", () => highlight(index));
      return element;
    }));
    list.hidden = false;
  };

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.addEventListener("input", render);
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (event) => {
    if (list.hidden) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      // 在“不选（按输入内容打开）”和各条建议之间循环。
      const next = selected + (event.key === "ArrowDown" ? 1 : -1);
      highlight(next >= items.length ? -1 : next < -1 ? items.length - 1 : next);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });

  return {
    /** 用户用方向键选中的建议；没有选中时返回 null（按输入内容打开）。 */
    picked: () => (selected >= 0 ? items[selected]?.url ?? null : null),
    close,
    isOpen: () => !list.hidden,
  };
}
