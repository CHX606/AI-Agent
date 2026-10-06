/** “外部工具”弹窗：配置交给主 Agent 使用的 MCP Server。 */
import type { McpServer } from "../shared/contracts.js";
import { errorText } from "./dom.js";
import { describeServer, parseArgs, parseEnv, parseHeaders } from "./mcp-format.js";

const SAVED_HINT = "保存后从下一轮任务开始生效。";

export async function renderMcpPanel(body: HTMLElement): Promise<void> {
  let servers: McpServer[] = (await window.bitAgent.listMcpServers()).map((server) => ({ ...server }));
  let dirty = false;
  const intro = document.createElement("div");
  intro.className = "review-explanation";
  intro.textContent = "把 MCP Server 提供的工具交给主 Agent 使用，例如查文档、读 Issue。这些工具在本机或远程服务上运行，不在隔离环境中，"
    + "也不进入改动审阅；默认每次调用前都会询问你。只读模式下不连接外部工具。";
  const list = document.createElement("div");
  list.className = "mcp-list";
  const add = document.createElement("details");
  add.className = "mcp-add";
  add.innerHTML = `<summary>添加服务</summary>
    <form class="mcp-form">
      <h3 class="mcp-form-title">添加服务</h3>
      <div class="model-field"><label>名称</label><input name="name" required maxlength="32" pattern="[A-Za-z0-9_\\-]+" placeholder="例如 docs，只能用字母、数字、_ 和 -"></div>
      <div class="model-field"><label>类型</label><select name="type"><option value="stdio">本机命令（stdio）</option><option value="http">远程地址（HTTP）</option></select></div>
      <div class="model-field" data-for="stdio"><label>命令</label><input name="command" spellcheck="false" placeholder="例如 npx"></div>
      <div class="model-field" data-for="stdio"><label>参数（每行一个）</label><textarea name="args" rows="3" spellcheck="false" placeholder="-y&#10;@modelcontextprotocol/server-everything"></textarea></div>
      <div class="model-field" data-for="stdio"><label>环境变量（每行一个 KEY=VALUE，可选）</label><textarea name="env" rows="2" spellcheck="false" placeholder="GITHUB_TOKEN=..."></textarea><p>值由 Windows 加密保存，之后只显示变量名。</p></div>
      <div class="model-field" data-for="http" hidden><label>地址</label><input name="url" type="url" spellcheck="false" placeholder="https://example.com/mcp"></div>
      <div class="model-field" data-for="http" hidden><label>请求头（每行一个 Name: Value，可选）</label><textarea name="headers" rows="2" spellcheck="false" placeholder="Authorization: Bearer ..."></textarea><p>用于令牌等认证信息。值由 Windows 加密保存，之后只显示请求头名称。</p></div>
      <div class="mcp-form-actions"><button type="button" class="button-secondary" data-action="cancel">取消</button><button type="submit" class="button-secondary">加入列表</button></div>
    </form>`;
  const footer = document.createElement("div");
  footer.className = "model-settings-footer mcp-footer";
  const hint = document.createElement("span");
  hint.setAttribute("role", "status");
  const save = document.createElement("button");
  save.type = "button";
  save.className = "button-primary";
  save.textContent = "保存";
  footer.append(hint, save);
  body.querySelector(".product-loading")?.remove();
  body.setAttribute("aria-busy", "false");
  body.append(intro, list, add, footer);

  /** 提示放在常驻底栏里，弹窗滚动到哪里都看得到。 */
  function status(text: string, kind?: "success" | "error" | "dirty"): void {
    hint.textContent = text;
    if (kind) hint.dataset.kind = kind;
    else delete hint.dataset.kind;
  }
  function changed(text: string): void {
    dirty = true;
    save.disabled = false;
    status(text, "dirty");
  }
  function refreshFooter(): void {
    save.disabled = !dirty;
    if (dirty) status("有未保存的更改。", "dirty");
    else status(SAVED_HINT);
  }

  const form = add.querySelector<HTMLFormElement>("form")!;
  const kind = form.elements.namedItem("type") as HTMLSelectElement;
  kind.addEventListener("change", () => {
    for (const field of form.querySelectorAll<HTMLElement>("[data-for]")) field.hidden = field.dataset.for !== kind.value;
  });
  add.addEventListener("toggle", () => {
    if (!add.open) return;
    form.scrollIntoView({ block: "nearest", behavior: "smooth" });
    (form.elements.namedItem("name") as HTMLInputElement).focus({ preventScroll: true });
  });
  form.querySelector<HTMLButtonElement>("[data-action=cancel]")!.addEventListener("click", () => {
    form.reset();
    kind.dispatchEvent(new Event("change"));
    add.open = false;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement).value;
    try {
      const name = value("name").trim();
      if (servers.some((server) => server.name.toLowerCase() === name.toLowerCase())) throw new Error(`已经有名为 ${name} 的服务`);
      const server: McpServer = kind.value === "stdio"
        ? { name, type: "stdio", command: value("command").trim(), args: parseArgs(value("args")),
          env: parseEnv(value("env")), enabled: true, auto_approve: false }
        : { name, type: "http", url: value("url").trim(), headers: parseHeaders(value("headers")), enabled: true, auto_approve: false };
      if (server.type === "stdio" && !server.command) throw new Error("请填写要运行的命令");
      if (server.type === "http" && !server.url) throw new Error("请填写服务地址");
      servers = [...servers, server];
      form.reset();
      kind.dispatchEvent(new Event("change"));
      add.open = false;
      draw();
      changed(`已加入 ${name}，点“保存”后生效。`);
    } catch (error) { status(errorText(error), "error"); }
  });

  function toggle(server: McpServer, key: "enabled" | "auto_approve", label: string, note: string, entry: HTMLElement): HTMLLabelElement {
    const wrapper = document.createElement("label");
    wrapper.className = "mcp-switch";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.setAttribute("role", "switch");
    box.checked = server[key];
    box.addEventListener("change", () => {
      server[key] = box.checked;
      if (key === "enabled") entry.dataset.enabled = String(box.checked);
      changed("有未保存的更改。");
    });
    const text = document.createElement("span");
    text.textContent = label;
    wrapper.append(box, text);
    if (note) {
      const small = document.createElement("small");
      small.textContent = note;
      wrapper.append(small);
    }
    return wrapper;
  }

  function draw(): void {
    list.replaceChildren();
    if (!servers.length) {
      const empty = document.createElement("p");
      empty.className = "product-empty";
      empty.textContent = "还没有配置外部工具。";
      list.append(empty);
    }
    for (const server of servers) {
      const entry = document.createElement("article");
      entry.className = "mcp-entry";
      entry.dataset.enabled = String(server.enabled);
      const header = document.createElement("header");
      const title = document.createElement("strong");
      title.textContent = server.name;
      const type = document.createElement("span");
      type.className = "mcp-type";
      type.textContent = server.type === "stdio" ? "本机命令" : "远程地址";
      const actions = document.createElement("div");
      actions.className = "change-actions";
      const test = document.createElement("button");
      test.type = "button";
      test.className = "button-secondary";
      test.textContent = "测试";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button-secondary change-undo";
      remove.textContent = "删除";
      actions.append(test, remove);
      header.append(title, type, actions);
      const target = document.createElement("code");
      target.className = "mcp-target";
      target.textContent = describeServer(server);
      target.title = target.textContent;
      entry.append(header, target);
      const [label, fresh, savedKeys] = server.type === "http"
        ? ["请求头", server.headers, server.headerKeys] as const
        : ["环境变量", server.env, server.envKeys] as const;
      const keys = fresh ? Object.keys(fresh) : savedKeys ?? [];
      if (keys.length) {
        const secrets = document.createElement("p");
        secrets.className = "mcp-env";
        secrets.textContent = `${label}：${keys.join("、")}（${fresh ? "保存时加密" : "已加密保存"}）`;
        entry.append(secrets);
      }
      const switches = document.createElement("div");
      switches.className = "mcp-switches";
      switches.append(
        toggle(server, "enabled", "启用", "", entry),
        toggle(server, "auto_approve", "自动批准", "仅在“允许修改”模式下生效", entry),
      );
      entry.append(switches);
      const result = document.createElement("p");
      result.className = "mcp-test-result";
      result.hidden = true;
      entry.append(result);
      test.addEventListener("click", async () => {
        test.disabled = true;
        test.textContent = "正在连接…";
        try {
          const outcome = await window.bitAgent.testMcpServer(server);
          result.dataset.ok = String(outcome.ok);
          result.textContent = outcome.ok
            ? `${outcome.message}：${outcome.tools.slice(0, 30).join("、")}${outcome.tools.length > 30 ? "…" : ""}`
            : `连接失败：${outcome.message}`;
          result.hidden = false;
        } catch (error) { status(errorText(error), "error"); }
        finally { test.disabled = false; test.textContent = "测试"; }
      });
      remove.addEventListener("click", () => {
        servers = servers.filter((item) => item !== server);
        draw();
        changed(`已移除 ${server.name}，点“保存”后生效。`);
      });
      list.append(entry);
    }
  }

  save.addEventListener("click", async () => {
    save.disabled = true;
    save.textContent = "正在保存…";
    try {
      servers = (await window.bitAgent.saveMcpServers(servers)).map((server) => ({ ...server }));
      dirty = false;
      draw();
      refreshFooter();
      status("已保存，将用于下一轮任务。", "success");
    } catch (error) {
      save.disabled = false;
      status(errorText(error), "error");
    } finally { save.textContent = "保存"; }
  });
  draw();
  refreshFooter();
}
