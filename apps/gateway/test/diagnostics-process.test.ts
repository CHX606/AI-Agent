import { mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, test, vi } from "vitest";
import { createDiagnostics } from "@bit-agent/diagnostics";
import { LocalTaskStore } from "../src/infrastructure/runtime/local-task-store.js";

test("real Python child exit rejects pending RPC and persists a correlated diagnosis", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const directory = mkdtempSync(join(root, "tmp", "diagnostics-process-"));
  vi.stubEnv("BIT_AGENT_PROJECT_ROOT", root);
  vi.stubEnv("BIT_AGENT_DATA_DIR", join(directory, "data"));
  vi.stubEnv("BIT_AGENT_LOG_DIR", join(directory, "logs"));
  const diagnostics = createDiagnostics({ process: "gateway", directory: join(directory, "logs") });
  let store: LocalTaskStore | undefined;
  try {
    store = await LocalTaskStore.connect(diagnostics);
    const child = (store as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill();
    await exited;
    await expect(store.call("health")).rejects.toThrow("不可用");
    await diagnostics.close();
    const lines = readFileSync(join(directory, "logs", "gateway", "current.jsonl"), "utf8");
    expect(lines).toContain("python_exit");
    expect(lines).toContain("unexpected");
    expect(lines).toMatch(/D-[a-f0-9]{16}/u);
  } finally {
    await store?.close(); await diagnostics.close(); vi.unstubAllEnvs();
  }
}, 20_000);
