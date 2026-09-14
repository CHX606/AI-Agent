import { describe, expect, it } from "vitest";

import { eventPresentation, eventTitle, isMainAgentText, summarizeResult } from "../src/renderer/presentation.js";

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
      rounds: 6,
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
      rounds: 0,
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

it("attempted failed tests stay failed while absent lint stays unrun", () => {
  expect(summarizeResult({ result: {
    tests_passed: false, quality_checks_passed: false,
    tool_calls: [{ tool_name: "run_tests", status: "ERROR" }],
  } })).toMatchObject({ testsPassed: false, qualityPassed: null });
});
