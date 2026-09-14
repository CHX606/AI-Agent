import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { buildApp } from "../src/bootstrap.js";
import { LocalTaskStore } from "../src/infrastructure/runtime/local-task-store.js";

// Real Gateway -> RPC -> Python -> SDK -> read_file -> SQLite, with a local model fixture.
test.skipIf(process.env.BIT_AGENT_TEST_ROUND_BUDGET !== "1")("configured budget reaches the real local execution loop", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  mkdirSync(join(root, "tmp"), { recursive: true });
  const directory = mkdtempSync(join(root, "tmp", "round-budget-integration-"));
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "sample.txt"), "read-only fixture");
  const counts = new Map<string, number>();
  const model = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw);
    const objective = body.input.filter((item: any) => item.role === "user").at(-1)?.content;
    const index = (counts.get(objective) ?? 0) + 1;
    counts.set(objective, index);
    const output = index <= 25
      ? [{ type: "function_call", call_id: `read-${index}`, name: "read_file", arguments: JSON.stringify({ path: "sample.txt" }) }]
      : [{ type: "message", id: "final", status: "completed", role: "assistant", content: [{ type: "output_text", text: "fixture complete", annotations: [] }] }];
    const complete = { id: `resp-${index}`, object: "response", created_at: 1, status: "completed", model: "round-fixture", output };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ type: "response.completed", response: complete })}\n\n`);
  });
  await new Promise<void>(done => model.listen(0, "127.0.0.1", done));
  const address = model.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not listen");
  for (const [name, value] of Object.entries({ BIT_AGENT_PROJECT_ROOT: root, BIT_AGENT_DATA_DIR: join(directory, "data"),
    BIT_AGENT_LOG_DIR: join(directory, "logs"), API_KEY: "local-fixture-only", MODEL_NAME: "round-fixture",
    BASE_URL: `http://127.0.0.1:${address.port}/v1`, BIT_AGENT_STREAMING: "1", BIT_AGENT_TASK_TIMEOUT_SECONDS: "45",
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" })) vi.stubEnv(name, value);
  let store: LocalTaskStore | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    store = await LocalTaskStore.connect();
    app = buildApp({ logger: false, taskStore: store });
    for (const limit of [25, 2]) {
      const response = await app.inject({ method: "POST", url: "/v1/tasks", payload: {
        objective: `round-budget-${limit}`, workspace_root: workspace,
        multi_agent_mode: "off", permission_mode: "read_only", max_tool_rounds: limit,
      } });
      expect(response.statusCode).toBe(202);
      const created = response.json();
      expect(created.max_tool_rounds).toBe(limit);
      let task = created;
      for (let attempt = 0; attempt < 600 && !["COMPLETED", "FAILED"].includes(task.status); attempt++) {
        await new Promise(done => setTimeout(done, 50));
        task = (await app.inject({ method: "GET", url: `/v1/tasks/${created.task_id}` })).json();
      }
      expect(task.status).toBe(limit === 25 ? "COMPLETED" : "FAILED");
      expect(task.result.rounds).toBe(limit);
      expect(task.result.tool_calls).toHaveLength(limit);
      expect(task.result.tool_calls.every((call: any) => call.status === "SUCCESS")).toBe(true);
      expect(task.max_tool_rounds).toBe(limit);
    }
  } finally {
    if (app) await app.close(); else await store?.close();
    await new Promise<void>(done => model.close(() => done()));
    vi.unstubAllEnvs();
  }
}, 60_000);
