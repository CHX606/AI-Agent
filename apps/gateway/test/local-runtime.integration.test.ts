import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

import { buildApp } from "../src/bootstrap.js";
import { LocalTaskStore } from "../src/infrastructure/runtime/local-task-store.js";

// 单独启用这项验收：会启动本机 Python 和真实 Electron，但模型仅使用本机假服务。
test.skipIf(process.env.BIT_AGENT_TEST_LOCAL_RUNTIME !== "1")(
  "local runtime: HTTP, SSE, restart, cancellation and real Electron",
  async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const directory = mkdtempSync(join(root, "tmp", "local-acceptance-"));
    const workspace = join(directory, "workspace");
    const other = join(directory, "other");
    mkdirSync(workspace);
    mkdirSync(other);
    const requests: Array<Record<string, any>> = [];
    const held: ServerResponse[] = [];
    const model = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const input = JSON.parse(body) as Record<string, any>;
      requests.push(input);
      const users = input.input.filter((item: any) => item.role === "user").map((item: any) => String(item.content));
      const tools = new Set(input.tools.map((tool: any) => tool.name));
      const priorOutput = input.input.some((item: any) => item.type === "function_call_output");
      const wantsDelegation = input.input.some((item: any) => item.role === "developer" && String(item.content).includes("本轮开启多 Agent"));
      if (users.at(-1) === "__WAIT__") { held.push(response); return; }
      const text = `Local model: ${users.join(" | ")}`;
      const output = wantsDelegation && tools.has("delegate_tasks") && !priorOutput
        ? [{ type: "function_call", call_id: "call-local-test", name: "delegate_tasks", arguments: JSON.stringify({ tasks: [{ objective: "inspect A" }, { objective: "inspect B" }] }) }]
        : [{ type: "message", id: `msg-${requests.length}`, status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }];
      if (users.at(-1) === "desktop first") await new Promise((done) => setTimeout(done, 1800));
      const complete = { id: `resp-${requests.length}`, object: "response", created_at: 1, status: "completed", model: "local-test", output };
      if (input.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const event = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
        event({ type: "response.created", response: { ...complete, status: "in_progress", output: [] } });
        if (output[0]?.type === "message") event({ type: "response.output_text.delta", delta: text, item_id: "message", output_index: 0, content_index: 0 });
        event({ type: "response.completed", response: complete });
        response.end();
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(complete));
      }
    });
    await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
    const address = model.address();
    if (!address || typeof address === "string") throw new Error("假模型启动失败");
    const previous = { ...process.env };
    Object.assign(process.env, {
      BIT_AGENT_DATA_DIR: join(directory, "data"), BIT_AGENT_PROJECT_ROOT: root,
      API_KEY: "local-acceptance-not-a-real-key", BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      MODEL_NAME: "local-test", BIT_AGENT_RUNTIME: "local", BIT_AGENT_TASK_TIMEOUT_SECONDS: "45",
    });
    let store = await LocalTaskStore.connect();
    let app = buildApp({ taskStore: store, logger: false });
    let base = await app.listen({ host: "127.0.0.1", port: 0 });

    async function api(path: string, method = "GET", body?: unknown): Promise<any> {
      const response = await fetch(base + path, {
        method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
      return result;
    }
    async function finished(task: any): Promise<any> {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const current = await api(`/v1/tasks/${task.task_id}`);
        if (["COMPLETED", "FAILED", "CANCELLED"].includes(current.status)) return current;
        await new Promise((done) => setTimeout(done, 50));
      }
      throw new Error("任务未按时结束");
    }
    try {
      const first = await api("/v1/tasks", "POST", { objective: "remember CANARY-73", workspace_root: workspace, multi_agent_mode: "off" });
      expect((await finished(first)).status).toBe("COMPLETED");
      expect(requests[0]?.tools.some((tool: any) => tool.name === "delegate_tasks")).toBe(false);
      const events = await (await fetch(`${base}/v1/tasks/${first.task_id}/events`)).text();
      expect(events).toContain("AGENT_COMPLETED");
      expect(events).toContain("TASK_FINISHED");
      const second = await api("/v1/tasks", "POST", { objective: "continue", workspace_root: workspace, session_id: first.session_id, multi_agent_mode: "auto" });
      expect((await finished(second)).result.final_answer).toContain("CANARY-73");
      expect((await api(`/v1/sessions/${first.session_id}`)).turns).toHaveLength(2);

      const delegated = await api("/v1/tasks", "POST", { objective: "investigate", workspace_root: other, multi_agent_mode: "on" });
      expect((await finished(delegated)).result.tool_calls[0].tool_name).toBe("delegate_tasks");
      const childCalls = requests.filter((request) => request.input.some((item: any) => item.content === "inspect A" || item.content === "inspect B"));
      expect(childCalls).toHaveLength(2);
      for (const request of childCalls) expect(request.tools.map((tool: any) => tool.name).sort()).toEqual(["list_files", "read_file", "search_code"]);

      const waiting = await api("/v1/tasks", "POST", { objective: "__WAIT__", workspace_root: workspace });
      for (let attempt = 0; attempt < 100 && held.length === 0; attempt += 1) await new Promise((done) => setTimeout(done, 20));
      expect(held.length).toBe(1);
      const queued = await api("/v1/tasks", "POST", { objective: "queued", workspace_root: workspace });
      expect((await api(`/v1/tasks/${queued.task_id}`)).status).toBe("QUEUED");
      await api(`/v1/tasks/${queued.task_id}`, "DELETE");
      expect((await finished(queued)).status).toBe("CANCELLED");
      await api(`/v1/tasks/${waiting.task_id}`, "DELETE");
      expect((await finished(waiting)).status).toBe("CANCELLED");
      for (const response of held.splice(0)) { response.writeHead(503); response.end(); }

      await app.close();
      store = await LocalTaskStore.connect();
      app = buildApp({ taskStore: store, logger: false });
      base = await app.listen({ host: "127.0.0.1", port: 0 });
      const resumed = await api("/v1/tasks", "POST", { objective: "after restart", workspace_root: workspace, session_id: first.session_id, multi_agent_mode: "off" });
      expect((await finished(resumed)).result.final_answer).toContain("CANARY-73");

      const ordinaryRead = store.readEvents.bind(store);
      let disconnected = false;
      let resumedWithCursor = false;
      store.readEvents = async (taskId, afterId, blockMs) => {
        const task = await store.getTask(taskId);
        if (task?.objective === "desktop first" && afterId !== "0-0") {
          if (!disconnected) { disconnected = true; throw new Error("deliberate acceptance disconnect"); }
          resumedWithCursor = true;
        }
        return ordinaryRead(taskId, afterId, blockMs);
      };
      const electron = join(root, "apps/desktop/node_modules/electron/dist", process.platform === "win32" ? "electron.exe" : "electron");
      if (!existsSync(electron)) throw new Error("需要安装 Electron 才能完成桌面验收");
      const env: NodeJS.ProcessEnv = { ...process.env, ACCEPTANCE_GATEWAY: base, ACCEPTANCE_ROOT: root, ACCEPTANCE_WORKSPACE: workspace, ACCEPTANCE_OTHER: other, ACCEPTANCE_OUTPUT: directory };
      delete env.ELECTRON_RUN_AS_NODE;
      const desktop = await promisify(execFile)(electron, [join(root, "apps/desktop/test/local-acceptance.cjs")], { env, timeout: 45000, windowsHide: true });
      expect(desktop.stdout).toContain("DESKTOP_ACCEPTANCE_PASSED");
      expect(disconnected).toBe(true);
      expect(resumedWithCursor).toBe(true);
      console.log(`LOCAL_ACCEPTANCE_PASSED ${directory}`);
    } finally {
      for (const response of held) response.destroy();
      await app.close();
      model.closeAllConnections();
      await new Promise<void>((done) => model.close(() => done()));
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  }, 90000,
);
