import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type {} from "../src/renderer/global";
import { mountProfileMenu } from "../src/renderer/profile-menu";

const mocks = vi.hoisted(() => ({ element: vi.fn() }));
vi.mock("../src/renderer/dom", () => ({ element: mocks.element }));

class MenuElement {
  hidden = true;
  title = "";
  textContent = "";
  dataset: Record<string, string> = {};
  handlers = new Map<string, (event: unknown) => void>();
  focus = vi.fn();
  setAttribute = vi.fn();
  contains = vi.fn(() => false);
  querySelector = vi.fn(() => null);
  addEventListener(type: string, callback: (event: unknown) => void): void { this.handlers.set(type, callback); }
}

let nodes: Record<string, MenuElement>;
let name: MenuElement;
let avatar: MenuElement;
let version: MenuElement;

beforeEach(() => {
  vi.clearAllMocks();
  nodes = Object.fromEntries(["#profile-button", "#profile-menu", "#connection-dot"]
    .map((selector) => [selector, new MenuElement()]));
  nodes["#connection-dot"]!.title = "本地服务启动失败：端口被占用";
  name = new MenuElement();
  avatar = new MenuElement();
  version = new MenuElement();
  mocks.element.mockImplementation((selector: string) => {
    if (!nodes[selector]) throw new Error(`不存在的界面元素：${selector}`);
    return nodes[selector];
  });
  vi.stubGlobal("window", { bitAgent: { runtimeConfig: { userName: "Administrator", version: "1.0.0" } } });
  vi.stubGlobal("document", {
    querySelectorAll: (selector: string) => selector === ".profile-name" ? [name]
      : selector === ".profile-avatar" ? [avatar] : [version],
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
});

afterEach(() => vi.unstubAllGlobals());

it("mounts identity without requiring connection text or replacing the existing service error tooltip", () => {
  mountProfileMenu();
  expect(mocks.element.mock.calls.map(([selector]) => selector)).toEqual(["#profile-button", "#profile-menu"]);
  expect(name.textContent).toBe("Administrator");
  expect(avatar.textContent).toBe("A");
  expect(version.textContent).toBe("1.0");
  expect(nodes["#connection-dot"]!.title).toBe("本地服务启动失败：端口被占用");
});

it("opens the retained settings menu and closes it with Escape, restoring avatar button focus", () => {
  mountProfileMenu();
  nodes["#profile-button"]!.handlers.get("click")!({ detail: 1 });
  expect(nodes["#profile-menu"]!.hidden).toBe(false);
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  nodes["#profile-menu"]!.handlers.get("keydown")!({ key: "Escape", preventDefault, stopPropagation });
  expect(nodes["#profile-menu"]!.hidden).toBe(true);
  expect(nodes["#profile-button"]!.focus).toHaveBeenCalled();
});
