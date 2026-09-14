import { expect, test } from "vitest";
import { GatewayClient } from "../src/main/infrastructure/gateway/gateway-client.js";
import type { DiagnosticPort } from "@bit-agent/diagnostics";

test("HTTP errors retain upstream diagnosis, never expose body, and do not retry writes", async () => {
  const records: unknown[] = [];
  const diagnostic: DiagnosticPort = { record: () => {}, failure: (_event, error, fields) => {
    records.push(fields); return (error as { diagnostic_id: string }).diagnostic_id;
  } };
  let attempts = 0;
  const client = new GatewayClient(diagnostic, () => ({ authorization: "Bearer PRIVATE" }), async (_url, init) => {
    attempts++;
    expect(init?.headers).toHaveProperty("x-request-id");
    return new Response(JSON.stringify({ diagnostic_id: "D-1234567890abcdef", message: "PRIVATE CONTENT" }), { status: 500 });
  });
  await expect(client.request("http://127.0.0.1:1234", "/v1/tasks/task-1", { method: "POST", body: "PRIVATE PROMPT" }))
    .rejects.toThrow("D-1234567890abcdef");
  expect(attempts).toBe(1);
  expect(JSON.stringify(records)).not.toContain("PRIVATE");
});
