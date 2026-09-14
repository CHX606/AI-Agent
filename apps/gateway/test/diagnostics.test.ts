import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { createDiagnostics } from "@bit-agent/diagnostics";
import { buildApp } from "../src/bootstrap.js";
import { MemoryTaskStore } from "../src/infrastructure/persistence/memory-task-store.js";

test("HTTP failure preserves structured correlation, and sanitizes response and logs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-diagnostics-"));
  const diagnostics = createDiagnostics({ process: "gateway", directory });
  const store = new MemoryTaskStore();
  store.getTask = async () => { throw Object.assign(new Error("PRIVATE PROMPT sk-hidden"), { code: "EIO" }); };
  const app = buildApp({ taskStore: store, diagnostics });
  const response = await app.inject({ url: "/v1/tasks/task-1", headers: { "x-request-id": "D-1234567890abcdef" } });
  expect(response.statusCode).toBe(500);
  expect(response.json().diagnostic_id).toMatch(/^D-[a-f0-9]{16}$/u);
  expect(response.body).not.toContain("PRIVATE");
  await app.close(); await diagnostics.close();
  const text = readFileSync(join(directory, "gateway", "current.jsonl"), "utf8");
  expect(text).toContain("D-1234567890abcdef");
  expect(text).not.toContain("PRIVATE");
});
