import { describe, expect, it } from "vitest";

import type { LongTermMemory } from "../src/shared/contracts";
import { memoryKindLabel, memoryMeta, memoryProjectName } from "../src/renderer/memory-panel";

const memory: LongTermMemory = {
  id: "m1", kind: "PROCEDURE", memory_key: "project.testing.docker", title: "测试在 Docker 中运行",
  content: "本项目的单元测试依赖 Docker 沙箱。", applicability: "测试任务", tags: [],
  project_id: "d:/work/calculator", source_run_ids: ["r1", "r2"],
  created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-25T08:00:00Z",
};

describe("memory panel formatting", () => {
  it("labels kinds in plain language and falls back for unknown kinds", () => {
    expect(memoryKindLabel("PROCEDURE")).toBe("做法");
    expect(memoryKindLabel("DECISION")).toBe("决定");
    expect(memoryKindLabel("SOMETHING_NEW")).toBe("经验");
  });

  it("shows only the last folder of the project path", () => {
    expect(memoryProjectName("d:/work/calculator")).toBe("calculator");
    expect(memoryProjectName("c:\\users\\me\\demo")).toBe("demo");
    expect(memoryProjectName(null)).toBe("通用");
  });

  it("includes the project only when listing all projects", () => {
    expect(memoryMeta(memory, false)).toMatch(/^更新于 .+ · 来自 2 次任务$/u);
    expect(memoryMeta(memory, true)).toMatch(/^项目：calculator · 更新于 .+ · 来自 2 次任务$/u);
    expect(memoryMeta({ ...memory, updated_at: "not a date" }, false)).toBe("来自 2 次任务");
  });
});
