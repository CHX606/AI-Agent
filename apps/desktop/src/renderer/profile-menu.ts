/**
 * 左下角的个人中心（参照 Claude 桌面版）：头像、用户名和版本号；点开向上弹出菜单，
 * 里面是模型设置、执行设置、外部工具、长期记忆、日志与诊断、连接设置和主题切换。
 * 各设置模块仍把自己的按钮插到 #settings-panel 前面，这里只负责弹出、收起和显示。
 */
import { element } from "./dom";

export function mountProfileMenu(options: { toggleTheme(): void }): void {
  const button = element<HTMLButtonElement>("#profile-button");
  const menu = element<HTMLElement>("#profile-menu");
  const themeItem = element<HTMLButtonElement>("#profile-theme");
  const connectionDot = element<HTMLElement>("#connection-dot");
  const connectionLabel = element<HTMLElement>("#connection-state-label");

  // 用户名取本机账户名，头像用首字母；版本号去掉末尾的“.0”，显示为 1.0。
  const config = window.bitAgent.runtimeConfig;
  const name = config.userName?.trim() || "本机用户";
  const version = (config.version || "1.0.0").replace(/\.0$/u, "");
  for (const item of document.querySelectorAll<HTMLElement>(".profile-name")) item.textContent = name;
  for (const item of document.querySelectorAll<HTMLElement>(".profile-avatar")) item.textContent = name.slice(0, 1).toUpperCase();
  for (const item of document.querySelectorAll<HTMLElement>("#app-version, .app-version")) item.textContent = version;
  button.title = `${name} · Bit Agent ${version}`;

  const outside = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node) && !button.contains(event.target as Node)) close(false);
  };

  function open(fromKeyboard: boolean): void {
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
    // 用键盘打开时把焦点放到第一项；鼠标点开时不显示焦点框。
    if (fromKeyboard) menu.querySelector<HTMLElement>("button, summary")?.focus();
  }

  function close(restoreFocus: boolean): void {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    if (restoreFocus) button.focus();
  }

  button.addEventListener("click", (event) => (menu.hidden ? open(event.detail === 0) : close(true)));
  // 点了某个设置项（会打开对应的弹窗）就收起菜单；“连接设置”在菜单里就地展开，不收起。
  menu.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("#settings-panel")) return;
    if (target.closest("button")) close(false);
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      // 只关菜单，不能冒泡到全局的“Esc 暂停”。
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  });

  themeItem.addEventListener("click", () => options.toggleTheme());
  const paintTheme = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    themeItem.querySelector("span")!.textContent = dark ? "切换为浅色主题" : "切换为暗色主题";
  };
  new MutationObserver(paintTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  paintTheme();

  // 头像旁的小圆点表示本地服务连接状态；菜单里的“连接设置”同时写出文字。
  const paintConnection = () => {
    const state = connectionDot.dataset.connected;
    connectionLabel.textContent = state === "true" ? "已连接" : state === "false" ? "未连接" : state === "pending" ? "连接中" : "";
    connectionLabel.dataset.connected = state ?? "";
  };
  new MutationObserver(paintConnection).observe(connectionDot, { attributes: true, attributeFilter: ["data-connected"] });
  paintConnection();
}
