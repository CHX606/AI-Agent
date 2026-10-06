import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import { AgentToolError, BrowserAgent, formatConsole, formatSnapshot, UNTRUSTED_NOTICE } from "../src/main/transport/browser-agent";
import { BROWSER_READ_TOOLS, startBrowserMcpServer, type BrowserMcpEndpoint } from "../src/main/transport/browser-mcp-server";

function fakeContents(url = "https://example.com/") {
  const scripts: { code: string; gesture: boolean }[] = [];
  return {
    url, title: "Example", loading: false, scripts, results: [] as unknown[], loaded: [] as string[], keys: [] as unknown[],
    getURL() { return this.url; },
    getTitle() { return this.title; },
    isLoading() { return this.loading; },
    loadURL(next: string) { this.loaded.push(next); this.url = next; return Promise.resolve(); },
    executeJavaScriptInIsolatedWorld(_world: number, sources: { code: string }[], gesture = false) {
      scripts.push({ code: sources[0]?.code ?? "", gesture });
      return Promise.resolve(this.results.shift());
    },
    sendInputEvent(event: unknown) { this.keys.push(event); },
    navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() },
    reload: vi.fn(),
  };
}

function fakePane(agent = fakeContents(), current: ReturnType<typeof fakeContents> | null = null) {
  return {
    agent, current, errors: new Map<string, unknown>(),
    agentTab: vi.fn(function (this: any) { return { id: "agent-tab", contents: this.agent, console: [] }; }),
    currentTab: vi.fn(function (this: any) { return this.current && { id: "user-tab", contents: this.current, console: [] }; }),
    waitForLoad: vi.fn(async () => true),
    errorOf(this: any, id: string) { return this.errors.get(id) ?? null; },
    tabList: () => [{ id: "user-tab", title: "Mine", url: "https://mine.test/", loading: false, favicon: null, active: true },
      { id: "agent-tab", title: "Example", url: "https://example.com/", loading: false, favicon: null, agent: true, active: false }],
  };
}

it("formats snapshots and console output as untrusted data", () => {
  const text = formatSnapshot({ title: "Login", url: "https://x.test/login", text: "Welcome", truncated: false, moreElements: false,
    elements: [
      { ref: 1, role: "textbox", name: "Email", value: "a@b.c" },
      { ref: 2, role: "password", name: "Password", value: "（已填写，内容不显示）" },
      { ref: 3, role: "checkbox", name: "Remember", checked: false },
      { ref: 4, role: "link", name: "Help", href: "https://x.test/help" },
      { ref: 5, role: "button", name: "", disabled: true },
    ] }, "Agent 的页面");
  expect(text.startsWith(UNTRUSTED_NOTICE)).toBe(true);
  expect(text).toContain('[1] textbox "Email" 值="a@b.c"');
  expect(text).toContain('[3] checkbox "Remember" 未勾选');
  expect(text).toContain('[4] link "Help" → https://x.test/help');
  expect(text).toContain('[5] button "（无名称）" 不可用');
  expect(formatConsole([{ level: "info", message: "hello", source: "", line: 0 },
    { level: "error", message: "boom", source: "https://x.test/app.js", line: 7 }], "warning"))
    .toBe(`${UNTRUSTED_NOTICE}\n[error] boom (app.js:7)`);
  expect(formatConsole([], "error")).toContain("没有错误消息");
});

it("acts only in its own tab and explains failures", async () => {
  const pane = fakePane();
  const agent = new BrowserAgent(() => pane as any);
  await expect(agent.open("file:///C:/secret")).rejects.toThrow(AgentToolError);
  expect(await agent.open("http://localhost:5173/")).toContain("已打开");
  expect(pane.agent.loaded).toEqual(["http://localhost:5173/"]);

  pane.agent.results.push({ error: "元素编号 9 已失效（页面变化了），请先重新调用 snapshot。" });
  await expect(agent.click(9)).rejects.toThrow("请先重新调用 snapshot");
  pane.agent.results.push({ ok: true });
  expect(await agent.click(2)).toContain("已点击 [2]");
  expect(pane.agent.scripts.at(-1)!.gesture).toBe(true);

  pane.agent.results.push({ ok: true, value: "hello" }, { ok: true, submitted: false });
  expect(await agent.type(3, "hello", { clear: true, submit: true })).toContain("已在 [3] 输入并提交");
  expect(pane.agent.keys.map((event: any) => event.type)).toEqual(["keyDown", "char", "keyUp"]);
  await expect(agent.press("F13")).rejects.toThrow("不支持的按键");

  pane.errors.set("agent-tab", { code: -105, description: "ERR_NAME_NOT_RESOLVED", url: "https://nope.test/" });
  await expect(agent.open("https://nope.test/")).rejects.toThrow("打不开这个网页");

  await expect(agent.snapshot("current")).rejects.toThrow("用户当前没有打开网页");
  expect(agent.tabs()).toContain("（Agent 的标签页）");
  expect(new BrowserAgent(() => null).tabs.bind(new BrowserAgent(() => null))).toThrow("应用窗口还没有准备好");
});

let endpoint: BrowserMcpEndpoint | null = null;
afterEach(async () => { await endpoint?.close(); endpoint = null; });

it("serves the tools over MCP only with the token", async () => {
  const pane = fakePane();
  pane.agent.results.push({ title: "Example", url: "https://example.com/", text: "Hello", truncated: false, moreElements: false,
    elements: [{ ref: 1, role: "link", name: "More", href: "https://example.com/more" }] });
  endpoint = await startBrowserMcpServer(new BrowserAgent(() => pane as any));
  expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);

  const anonymous = await fetch(endpoint.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(anonymous.status).toBe(401);

  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url),
    { requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } } });
  // SDK 的类型在 exactOptionalPropertyTypes 下对不上（sessionId 可选与否），运行时是同一个对象。
  await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
  try {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ["click", "console", "navigate", "open", "press", "screenshot", "select", "snapshot", "tabs", "type", "wait"]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(BROWSER_READ_TOOLS.includes(tool.name));
    const snapshot = await client.callTool({ name: "snapshot", arguments: {} });
    expect((snapshot.content as { text: string }[])[0]!.text).toContain('[1] link "More" → https://example.com/more');
    const clicked = await client.callTool({ name: "click", arguments: { ref: 1 } });
    expect(clicked.isError).not.toBe(true);
    expect((clicked.content as { text: string }[])[0]!.text).toContain("已点击 [1]");
    const wrong = await client.callTool({ name: "open", arguments: { url: "javascript:alert(1)" } });
    expect(wrong.isError).toBe(true);
    expect((wrong.content as { text: string }[])[0]!.text).toBe("只能打开 http 或 https 地址。");
  } finally {
    await client.close();
  }
});
