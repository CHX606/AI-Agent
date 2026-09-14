import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { createDiagnostics, exportDiagnostics, publicError, registerSecret } from "../index.mjs";

test("rotation, age retention, safe export, correlation and normal actions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bit-diagnostics-"));
  await mkdir(join(directory, "electron"));
  const stale = join(directory, "electron", "111-1.jsonl");
  await writeFile(stale, "stale"); await utimes(stale, 1, 1);
  registerSecret("test-key-do-not-log");
  const log = createDiagnostics({ process: "electron", directory, maxBytes: 1200, maxFiles: 4 });
  for (let i = 0; i < 40; i++) {
    log.record("info", "user_cancelled", { task_id: "task-1", session_id: "session-1", count: i,
      prompt: "PROMPT-PRIVATE", headers: { authorization: "Bearer test-key-do-not-log" } });
    await log.flush();
  }
  const error = Object.assign(new Error("PRIVATE-FILE-CONTENT test-key-do-not-log"), { code: "ENOSPC" });
  const id = log.failure("save_failed", error, { task_id: "task-1", reason: "test-key-do-not-log" });
  assert.match(publicError(id), /D-[a-f0-9]{16}/u);
  await log.close();
  const files = (await readdir(join(directory, "electron"))).filter(n => n.endsWith(".jsonl"));
  assert.ok(files.length <= 4 && files.length >= 2);
  assert.ok(!files.includes("111-1.jsonl"));
  let total = 0;
  for (const name of files) total += (await stat(join(directory, "electron", name))).size;
  assert.ok(total < 6000, `rotation total ${total}`);
  await writeFile(join(directory, "electron", "private.txt"), "PRIVATE-LEGACY-LOG");
  const destination = join(directory, "report.zip");
  await exportDiagnostics({ directory, destination, version: "0.1.0", snapshot: {
    tasks: [{ task_id: "task-1", objective: "PRIVATE-OBJECTIVE", phase: "model" }],
    events: [{ event: "TOOL_COMPLETED", output: "PRIVATE-OUTPUT", tool_call_id: "call-1" }],
  } });
  const zip = new AdmZip(await readFile(destination));
  const content = zip.getEntries().map(e => zip.readAsText(e)).join("\n");
  for (const denied of ["PRIVATE-FILE-CONTENT", "test-key-do-not-log", "PROMPT-PRIVATE", "PRIVATE-LEGACY-LOG", "PRIVATE-OBJECTIVE", "PRIVATE-OUTPUT"])
    assert.ok(!content.includes(denied), denied);
  assert.ok(content.includes(id));
  assert.ok(content.includes("ENOSPC"));
  assert.ok(content.includes("call-1"));
});

test("unwritable sink never masks business failures; export can run without runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bit-diagnostics-"));
  const invalid = join(directory, "not-a-directory"); await writeFile(invalid, "x");
  const log = createDiagnostics({ process: "gateway", directory: invalid });
  const error = new Error("original");
  assert.doesNotThrow(() => log.failure("failed", error));
  assert.equal(error.message, "original");
  assert.equal(log.available(), false);
  const result = await exportDiagnostics({ directory: invalid, destination: join(directory, "fallback.zip"), version: "0.1.0", unavailable: true });
  const zip = new AdmZip(result.path);
  assert.equal(JSON.parse(zip.readAsText("manifest.json")).runtime_unavailable, true);
  await log.close();
});
