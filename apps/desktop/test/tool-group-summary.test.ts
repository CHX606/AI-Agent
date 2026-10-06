import { describe, expect, it } from "vitest";
import { summarizeToolGroup, toolGroupKind, type ToolRowSummary } from "../src/renderer/stream/tool-group-summary";

function row(tool: string, changes: Partial<ToolRowSummary> = {}): ToolRowSummary {
  return { tool, label: "修改文件", target: "app.py", summary: "1 个文件 +3 −1", tone: "success", ...changes };
}

describe("collapsed tool groups", () => {
  it("keeps reading operations together and other tools distinguishable", () => {
    expect(["read_file", "list_files", "search_code"].map(toolGroupKind)).toEqual(["read", "read", "read"]);
    expect(toolGroupKind("apply_patch")).not.toBe(toolGroupKind("run_tests"));
    expect(toolGroupKind("run_tests")).not.toBe(toolGroupKind("run_checks"));
    expect(toolGroupKind("mcp__a__read")).not.toBe(toolGroupKind("mcp__b__read"));
  });

  it("preserves the existing compact reading summary", () => {
    const summary = summarizeToolGroup([row("list_files"), row("read_file"), row("read_file")]);
    expect(summary.text).toBe("查看了 1 个目录，读取了 2 个文件");
    expect(summary.result).toBe("");
  });

  it("keeps modification targets and change counts visible before opening", () => {
    expect(summarizeToolGroup([row("apply_patch", { patch: { paths: ["app.py"], added: 3, removed: 1 } })])).toMatchObject({
      text: "修改了 1 个文件", result: "+3 −1", tone: "success", failed: 0,
    });
  });

  it("counts all paths in a multi-file operation, including paths absent from its display target", () => {
    const patch = { paths: ["one.py", "two.py", "three.py", "four.py"], added: 8, removed: 2 };
    expect(summarizeToolGroup([row("apply_patch", { target: "one.py, two.py, three.py", patch })])).toMatchObject({
      text: "修改了 4 个文件", result: "+8 −2",
    });
  });

  it("deduplicates files across operations while accumulating each successful change", () => {
    const first = row("apply_patch", { patch: { paths: ["src/app.py", "readme.md"], added: 3, removed: 1 } });
    const second = row("apply_patch", { patch: { paths: ["src\\app.py", "./readme.md"], added: 2, removed: 4 } });
    expect(summarizeToolGroup([first, second])).toMatchObject({ text: "修改了 2 个文件", result: "+5 −5" });
  });

  it("excludes failed attempts from file counts and keeps the failure visible", () => {
    const passed = row("apply_patch", { patch: { paths: ["app.py"], added: 3, removed: 1 } });
    const failed = row("apply_patch", { tone: "error", summary: "未找到要修改的内容",
      patch: { paths: ["missing.py"], added: 9, removed: 1 } });
    expect(summarizeToolGroup([failed, passed])).toMatchObject({ text: "修改了 1 个文件",
      result: "未找到要修改的内容", failed: 1, tone: "error" });
  });

  it("shows a file count while actual diffs are loading, without repeating an incomplete call result", () => {
    const first = row("apply_patch", { patch: { paths: ["app.py"], added: 3, removed: 1 } });
    const second = row("apply_patch", { patch: { paths: ["app.py", "readme.md"] } });
    expect(summarizeToolGroup([first, second])).toMatchObject({ text: "修改了 2 个文件", result: "" });
  });

  it("does not present unknown historical call counts as file counts or complete line totals", () => {
    const known = row("apply_patch", { patch: { paths: ["app.py"], added: 3, removed: 1 } });
    expect(summarizeToolGroup([known, row("apply_patch")])).toMatchObject({ text: "修改文件", result: "" });
    expect(summarizeToolGroup([row("apply_patch", { tone: "neutral", summary: "已停止" })])).toMatchObject({
      result: "已停止", tone: "neutral",
    });
  });

  it("preserves a stopped operation after an earlier successful modification", () => {
    const passed = row("apply_patch", { patch: { paths: ["app.py"], added: 3, removed: 1 } });
    const stopped = row("apply_patch", { tone: "neutral", summary: "已停止" });
    expect(summarizeToolGroup([passed, stopped])).toMatchObject({ text: "修改了 1 个文件", result: "已停止", tone: "neutral" });
  });

  it("does not hide an earlier test failure behind a later success", () => {
    const failed = row("run_tests", { tone: "error", summary: "2 个测试未通过", label: "运行测试" });
    const passed = row("run_tests", { summary: "4 个测试通过", label: "运行测试" });
    expect(summarizeToolGroup([failed, passed])).toMatchObject({
      text: "运行了 2 次测试", result: "2 个测试未通过", tone: "error", failed: 1, issues: "2 个测试未通过",
    });
  });

  it("retains unverified outcomes and warning counts", () => {
    const neutral = row("verify_project", { tone: "neutral", summary: "无法自动验证", label: "基础检查", target: "" });
    expect(summarizeToolGroup([neutral])).toMatchObject({ result: "无法自动验证", tone: "neutral", failed: 0 });
    const warning = row("verify_task", { tone: "warning", summary: "独立验收未完成" });
    expect(summarizeToolGroup([warning])).toMatchObject({ result: "独立验收未完成", tone: "warning", warning: 1 });
  });

  it("identifies external services instead of reducing them to anonymous operations", () => {
    const external = row("mcp__docs__search", { label: "外部工具", target: "docs · search", summary: "找到 3 项" });
    expect(summarizeToolGroup([external, external])).toMatchObject({
      text: "外部工具 docs · search 2 次", result: "找到 3 项",
    });
  });

  it("shows the current running operation while retaining the existing failure count", () => {
    expect(summarizeToolGroup([row("run_checks", { tone: "error" }), row("run_checks", {
      tone: "running", label: "运行检查", target: "lint", summary: "运行中…",
    })])).toMatchObject({ text: "运行检查 lint…", result: "", tone: "running", failed: 1 });
  });
});
