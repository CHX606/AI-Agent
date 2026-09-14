import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readExecutionSettings, writeExecutionSettings } from "../src/main/infrastructure/persistence/execution-settings.js";
import { taskRequestBody } from "../src/main/application/task-input.js";
import { parseExecutionSettings } from "../src/shared/execution-settings.js";

describe("execution settings", () => {
  it("defaults to 100 and reads the saved value after reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "bit-agent-execution-settings-"));
    expect(readExecutionSettings(directory)).toEqual({ maxToolRounds: 100 });
    expect(writeExecutionSettings(directory, { maxToolRounds: 325 })).toEqual({ maxToolRounds: 325 });
    expect(readExecutionSettings(directory)).toEqual({ maxToolRounds: 325 });
    expect(JSON.parse(readFileSync(join(directory, "execution-settings.json"), "utf8"))).toEqual({ maxToolRounds: 325 });
  });

  it.each([0, -1, 1.5, 1001, "20", null, true, NaN, Infinity, undefined])("rejects invalid limit %s", (value) => {
    expect(() => parseExecutionSettings({ maxToolRounds: value })).toThrow("整数");
  });

  it.each([1, 20, 100, 1000])("accepts integer limit %s", (value) => {
    expect(parseExecutionSettings({ maxToolRounds: value }).maxToolRounds).toBe(value);
  });

  it("does not overwrite a saved budget with invalid input", () => {
    const directory = mkdtempSync(join(tmpdir(), "bit-agent-execution-settings-"));
    writeExecutionSettings(directory, { maxToolRounds: 10 });
    expect(() => writeExecutionSettings(directory, { maxToolRounds: 0 })).toThrow();
    expect(readExecutionSettings(directory).maxToolRounds).toBe(10);
  });

  it("reports a damaged file rather than silently raising the budget, and permits explicit repair", () => {
    const directory = mkdtempSync(join(tmpdir(), "bit-agent-execution-settings-"));
    writeFileSync(join(directory, "execution-settings.json"), "{broken");
    expect(() => readExecutionSettings(directory)).toThrow("重新保存");
    writeExecutionSettings(directory, { maxToolRounds: 50 });
    expect(readExecutionSettings(directory).maxToolRounds).toBe(50);
  });

  it("snapshots settings into each task payload without changing a prior task", () => {
    const directory = mkdtempSync(join(tmpdir(), "bit-agent-execution-settings-"));
    const input = { gatewayUrl: "http://localhost:3000", objective: " inspect ", workspaceRoot: "D:\\project",
      sessionId: "session-1", multiAgentMode: "off" as const, permissionMode: "read_only" as const };
    writeExecutionSettings(directory, { maxToolRounds: 25 });
    const first = taskRequestBody(input, readExecutionSettings(directory));
    writeExecutionSettings(directory, { maxToolRounds: 250 });
    const second = taskRequestBody(input, readExecutionSettings(directory));
    expect(first).toEqual({ objective: "inspect", workspace_root: "D:\\project", session_id: "session-1",
      multi_agent_mode: "off", permission_mode: "read_only", max_tool_rounds: 25 });
    expect(second.max_tool_rounds).toBe(250);
    expect(first.max_tool_rounds).toBe(25);
  });
});
