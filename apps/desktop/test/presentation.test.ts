import { describe, expect, it } from "vitest";

import {
  estimateCost, eventPresentation, eventTitle, formatTokens, isMainAgentText, summarizeResult, usageDescription,
} from "../src/renderer/presentation.js";

describe("desktop result presentation", () => {
  it("reads the final agent result from a multi-agent envelope", () => {
    expect(
      summarizeResult({
        result: {
          final_agent_result: {
            final_answer: "修复完成",
            changed_files: ["src/app.py"],
            tests_passed: true,
            quality_checks_passed: true,
            rounds: 6,
          },
        },
      }),
    ).toEqual({
      answer: "修复完成",
      changedFiles: ["src/app.py"],
      testsPassed: true,
      qualityPassed: true,
      acceptanceStatus: "NOT_RUN",
      verificationStatus: "NOT_RUN",
      verificationNotes: [],
      rounds: 6,
      usage: null,
    });
  });

  it("turns tool events into readable operation titles", () => {
    expect(
      eventTitle({
        id: "1-0",
        event_type: "TOOL_COMPLETED",
        data: { payload: { tool_name: "run_tests", tool_call_id: "test-1", status: "SUCCESS",
          duration_ms: 23, operation: { target: "tests" } }, agent_id: "main" },
      }),
    ).toBe("测试已完成 tests");
  });

  it("merges tool start and completion using the same card key", () => {
    const requested = eventPresentation({ id: "1-0", event_type: "TOOL_REQUESTED",
      data: { payload: { tool_name: "read_file", tool_call_id: "read-1",
        operation: { target: "services/agent/manager.py" } } } });
    const completed = eventPresentation({ id: "2-0", event_type: "TOOL_COMPLETED",
      data: { payload: { tool_name: "read_file", tool_call_id: "read-1", status: "SUCCESS",
        operation: { target: "services/agent/manager.py" } } } });
    expect(requested).toMatchObject({ key: "tool:read-1", title: "正在读取 manager.py", tone: "running" });
    expect(completed).toMatchObject({ key: "tool:read-1", title: "已读取 manager.py", tone: "success" });
  });

  it("hides internal events from the customer timeline", () => {
    expect(eventPresentation({ id: "1-0", event_type: "CONTEXT_COMPACTED", data: {} })).toBeNull();
    // 整理过程只在状态行显示进度（stream-view 处理 CONTEXT_COMPACTING），不在对话流里留条目。
    expect(eventPresentation({ id: "1-1", event_type: "CONTEXT_COMPACTING", data: {} })).toBeNull();
    expect(eventTitle({ id: "2-0", event_type: "MEMORY_RECALLED", data: {} })).toBe("");
  });

  it("marks repository verification as not run for a direct reply", () => {
    expect(
      summarizeResult({
        result: {
          planning: { plan: { route: "direct", tasks: [] } },
          final_agent_result: {
            final_answer: "在的，有什么可以帮你？",
            tests_passed: false,
            quality_checks_passed: false,
            rounds: 0,
          },
        },
      }),
    ).toEqual({
      answer: "在的，有什么可以帮你？",
      changedFiles: [],
      testsPassed: null,
      qualityPassed: null,
      acceptanceStatus: "NOT_RUN",
      verificationStatus: "NOT_RUN",
      verificationNotes: [],
      rounds: 0,
      usage: null,
    });
  });

  it("does not report missing verification fields as failures", () => {
    expect(summarizeResult({ result: { final_answer: "任务失败" } })).toMatchObject({
      testsPassed: null,
      qualityPassed: null,
    });
  });
});

it("local chat without verification tools is not a failed test run", () => {
  expect(summarizeResult({ result: {
    final_answer: "普通回答", tests_passed: false, quality_checks_passed: false, tool_calls: [],
  } })).toMatchObject({ testsPassed: null, qualityPassed: null });
});

it("baseline success is not independent acceptance", () => {
  expect(summarizeResult({ tests_passed: true, quality_checks_passed: true }))
    .toMatchObject({ testsPassed: true, acceptanceStatus: "NOT_RUN" });
  expect(summarizeResult({ acceptance_status: "NOT_VERIFIED" }))
    .toMatchObject({ acceptanceStatus: "NOT_VERIFIED" });
  expect(summarizeResult({ acceptance_status: "PASSED" }))
    .toMatchObject({ acceptanceStatus: "PASSED" });
});

it("does not mix independent tester text into the author's reply", () => {
  expect(isMainAgentText({ agent_id: "acceptance-123" })).toBe(false);
  expect(isMainAgentText({ agent_id: "research-123" })).toBe(false);
  expect(isMainAgentText({ agent_id: "main" })).toBe(true);
  expect(isMainAgentText(null)).toBe(true);
  expect(eventTitle({ id: "tester", event_type: "AGENT_COMPLETED", data: { agent_id: "acceptance-123" } }))
    .toBe("测试 Agent 已返回，正在核对验收报告");
});

it("unverifiable changes are neither passed nor failed", () => {
  const summary = summarizeResult({ result: {
    tests_passed: false, quality_checks_passed: false,
    tool_calls: [{ tool_name: "verify_project", status: "ERROR" }],
    verification_status: "UNVERIFIED",
    verification_notes: ["找不到所属项目的测试配置（main.go）"],
  } });
  expect(summary).toMatchObject({
    testsPassed: null, qualityPassed: null, verificationStatus: "UNVERIFIED",
    verificationNotes: ["找不到所属项目的测试配置（main.go）"],
  });
  expect(summarizeResult({ verification_status: "bogus" }).verificationStatus).toBe("NOT_RUN");
});

it("shows an unavailable verification as neutral, not as a failure", () => {
  expect(eventPresentation({ id: "1-0", event_type: "TOOL_COMPLETED", data: { payload: {
    tool_name: "verify_project", tool_call_id: "v1", status: "ERROR", error_code: "VERIFICATION_UNAVAILABLE",
  } } })).toMatchObject({ title: "无法自动验证", tone: "neutral", status: "未验证" });
  expect(eventPresentation({ id: "1-0", event_type: "TOOL_COMPLETED", data: { payload: {
    tool_name: "verify_project", tool_call_id: "v1", status: "ERROR", error_code: "VERIFICATION_FAILED",
  } } })).toMatchObject({ title: "基础检查未通过", tone: "error" });
});

it("summarizes task usage including sub agents and estimates cost", () => {
  const summary = summarizeResult({ task_id: "t", status: "COMPLETED", result: {
    final_answer: "完成",
    task_usage: { requests: 3, input_tokens: 12_345, output_tokens: 2_100, by_agent: {
      main: { requests: 2, input_tokens: 12_000, output_tokens: 2_000 },
      research: { requests: 1, input_tokens: 345, output_tokens: 100 },
    } },
  } });
  expect(summary.usage).toEqual({ requests: 3, inputTokens: 12_345, outputTokens: 2_100, byAgent: {
    main: { requests: 2, inputTokens: 12_000, outputTokens: 2_000 },
    research: { requests: 1, inputTokens: 345, outputTokens: 100 },
  } });
  expect(usageDescription(summary.usage!)).toContain("调查子 Agent：1 次，输入 345，输出 100");
  expect([formatTokens(950), formatTokens(1_234), formatTokens(12_345), formatTokens(1_234_567)])
    .toEqual(["950", "1.23k", "12.3k", "1.23M"]);
  expect(estimateCost(summary.usage!, { input: 2, output: 8, currency: "¥" })).toBe("¥0.04");
  expect(estimateCost(summary.usage!, null)).toBeNull();
  expect(estimateCost(summary.usage!, { input: 0, output: 0, currency: "$" })).toBeNull();
  expect(summarizeResult({ result: { task_usage: { requests: 0 } } }).usage).toBeNull();
});

it("shows expected flow outcomes as neutral, not as failures", () => {
  const completed = (tool: string, code: string) => eventPresentation({ id: "9-0", event_type: "TOOL_COMPLETED",
    data: { payload: { tool_name: tool, tool_call_id: `${tool}-${code}`, status: "ERROR", error_code: code } } });
  expect(completed("verify_task", "ACCEPTANCE_NOT_APPLICABLE")).toMatchObject({ title: "无需独立验收", tone: "neutral" });
  expect(completed("run_tests", "USE_PROJECT_VERIFICATION")).toMatchObject({ title: "改用项目整体验证", tone: "neutral" });
  expect(completed("apply_patch", "PERMISSION_DENIED")).toMatchObject({ title: "未获批准，已跳过", tone: "neutral" });
  // 验收没能得出结论不是代码缺陷：琥珀色提醒，不用表示失败的红色。
  expect(completed("verify_task", "ACCEPTANCE_NOT_VERIFIED")).toMatchObject({ tone: "warning", status: "未完成" });
  expect(completed("verify_task", "ACCEPTANCE_FAILED")).toMatchObject({ tone: "error" });
  // 回答写在对应的工具行上，不再单独一行“已收到你的回答”。
  expect(eventPresentation({ id: "9-1", event_type: "USER_ANSWERED", data: {} })).toBeNull();
});

it("presents external MCP connections and calls", () => {
  expect(eventTitle({ id: "4-0", event_type: "EXTERNAL_TOOLS_LOADED", data: {
    connected: [{ name: "docs", tools: 3 }], failed: [{ name: "github", error: "x" }] } }))
    .toBe("已连接外部工具 docs（3 个工具）；外部工具连接失败：github");
  expect(eventPresentation({ id: "5-0", event_type: "TOOL_COMPLETED", data: { payload: {
    tool_name: "mcp__docs__search_pages", tool_call_id: "m1", status: "SUCCESS" } } }))
    .toMatchObject({ title: "外部工具已返回 docs · search_pages", tone: "success" });
  // 内置浏览器：说人话。
  expect(eventPresentation({ id: "6-0", event_type: "TOOL_REQUESTED", data: { payload: {
    tool_name: "mcp__browser__open", tool_call_id: "b1" } } }))
    .toMatchObject({ title: "正在使用 浏览器 · 打开网页", tone: "running" });
  expect(eventPresentation({ id: "6-1", event_type: "TOOL_COMPLETED", data: { payload: {
    tool_name: "mcp__browser__snapshot", tool_call_id: "b2", status: "SUCCESS" } } }))
    .toMatchObject({ title: "已完成 浏览器 · 读取页面", tone: "success" });
});

it("names the project instruction files that were read", () => {
  expect(eventTitle({ id: "3-0", event_type: "PROJECT_INSTRUCTIONS_LOADED",
    data: { paths: ["AGENTS.md", ".bit-agent/instructions.md"], truncated: false } }))
    .toBe("已读取项目说明 AGENTS.md、.bit-agent/instructions.md");
  expect(eventTitle({ id: "3-1", event_type: "PROJECT_INSTRUCTIONS_LOADED",
    data: { paths: ["AGENTS.md"], truncated: true } })).toBe("已读取项目说明 AGENTS.md（内容较长，已截断）");
});

it("attempted failed tests stay failed while absent lint stays unrun", () => {
  expect(summarizeResult({ result: {
    tests_passed: false, quality_checks_passed: false,
    tool_calls: [{ tool_name: "run_tests", status: "ERROR" }],
  } })).toMatchObject({ testsPassed: false, qualityPassed: null });
});
