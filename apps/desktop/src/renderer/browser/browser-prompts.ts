/** 网页的请求：权限（摄像头、定位等）和登录。一次显示一个，其余排队。 */
import type { BrowserPrompt } from "../../shared/contracts.js";

export function mountPrompts(container: HTMLElement): void {
  const queue: BrowserPrompt[] = [];
  const permission = container.querySelector<HTMLElement>(".browser-prompt-permission")!;
  const login = container.querySelector<HTMLFormElement>(".browser-prompt-login")!;
  const username = login.elements.namedItem("username") as HTMLInputElement;
  const password = login.elements.namedItem("password") as HTMLInputElement;

  const show = () => {
    const current = queue[0];
    container.hidden = !current;
    if (!current) return;
    permission.hidden = current.kind !== "permission";
    login.hidden = current.kind !== "login";
    for (const origin of container.querySelectorAll(".browser-prompt-origin")) origin.textContent = current.origin;
    if (current.kind === "permission") {
      container.querySelector(".browser-prompt-label")!.textContent = current.label;
    } else {
      container.querySelector(".browser-prompt-realm")!.textContent = current.proxy ? "（代理服务器）" : current.realm ? `（${current.realm}）` : "";
      username.value = "";
      password.value = "";
      username.focus();
    }
  };
  const answer = (value: Parameters<typeof window.bitAgent.answerBrowserPrompt>[1]) => {
    const current = queue.shift();
    if (current) void window.bitAgent.answerBrowserPrompt(current.id, value);
    // 密码不留在页面里。
    password.value = "";
    show();
  };

  window.bitAgent.onBrowserPrompt((prompt) => {
    if (prompt.kind === "dismiss") {
      const index = queue.findIndex((item) => item.id === prompt.id);
      if (index >= 0) { queue.splice(index, 1); show(); }
      return;
    }
    queue.push(prompt);
    if (queue.length === 1) show();
  });
  container.querySelector("[data-answer=allow]")!.addEventListener("click", () => answer({ allow: true }));
  container.querySelector("[data-answer=deny]")!.addEventListener("click", () => answer({ allow: false }));
  container.querySelector("[data-answer=cancel]")!.addEventListener("click", () => answer({ cancel: true }));
  login.addEventListener("submit", (event) => {
    event.preventDefault();
    answer({ username: username.value, password: password.value });
  });
  login.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); answer({ cancel: true }); } });
}
