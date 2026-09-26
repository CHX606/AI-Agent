import { describe, expect, it } from "vitest";

import { loadHistory, maximumHistoryEntries, saveHistory, type TaskHistoryEntry } from "../src/renderer/task-history";

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
    get raw() { return value; },
  };
}

const entry = (taskId: string): TaskHistoryEntry => ({
  taskId, objective: "inspect", workspaceRoot: "D:/demo", gatewayUrl: "http://127.0.0.1:3000",
  status: "COMPLETED", createdAt: "2026-09-25T00:00:00Z",
});

describe("task history storage", () => {
  it("returns an empty list for missing or corrupt data", () => {
    expect(loadHistory(memoryStorage())).toEqual([]);
    expect(loadHistory(memoryStorage("{not json"))).toEqual([]);
    expect(loadHistory(memoryStorage(JSON.stringify({ taskId: "x" })))).toEqual([]);
  });

  it("drops malformed entries and keeps valid ones in order", () => {
    const stored = [entry("a"), { taskId: "b" }, entry("c"), null, "text"];
    expect(loadHistory(memoryStorage(JSON.stringify(stored))).map((item) => item.taskId)).toEqual(["a", "c"]);
  });

  it("caps both loading and saving at the maximum length", () => {
    const many = Array.from({ length: maximumHistoryEntries + 5 }, (_, index) => entry(String(index)));
    expect(loadHistory(memoryStorage(JSON.stringify(many)))).toHaveLength(maximumHistoryEntries);
    const storage = memoryStorage();
    saveHistory(many, storage);
    expect(JSON.parse(storage.raw ?? "[]")).toHaveLength(maximumHistoryEntries);
  });
});
