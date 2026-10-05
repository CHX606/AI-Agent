/** 左下角个人中心：账户信息和设置菜单。 */
import { element } from "./dom";

function paintIdentity(button: HTMLButtonElement): void {
  const config = window.bitAgent.runtimeConfig;
  const name = config.userName?.trim() || "本机用户";
  const version = (config.version || "1.0.0").replace(/\.0$/u, "");
  for (const item of document.querySelectorAll<HTMLElement>(".profile-name")) item.textContent = name;
  for (const item of document.querySelectorAll<HTMLElement>(".profile-avatar")) item.textContent = name.slice(0, 1).toUpperCase();
  for (const item of document.querySelectorAll<HTMLElement>("#app-version, .app-version")) item.textContent = version;
  button.title = `${name} · Bit Agent ${version}`;
}

function bindMenuActions(menu: HTMLElement, close: (restoreFocus: boolean) => void): void {
  menu.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("button")) close(false);
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });
}

function bindProfileMenu(button: HTMLButtonElement, menu: HTMLElement): void {
  const outside = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node) && !button.contains(event.target as Node)) close(false);
  };
  function open(fromKeyboard: boolean): void {
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
    if (fromKeyboard) menu.querySelector<HTMLElement>("button")?.focus();
  }
  function close(restoreFocus: boolean): void {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    if (restoreFocus) button.focus();
  }
  button.addEventListener("click", (event) => (menu.hidden ? open(event.detail === 0) : close(true)));
  bindMenuActions(menu, close);
}

export function mountProfileMenu(): void {
  const button = element<HTMLButtonElement>("#profile-button");
  const menu = element<HTMLElement>("#profile-menu");
  paintIdentity(button);
  bindProfileMenu(button, menu);
}
