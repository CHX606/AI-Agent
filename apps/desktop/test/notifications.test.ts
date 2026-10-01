import { expect, it } from "vitest";

import { attentionNotice } from "../src/main/application/notifications.js";

const now = Date.parse("2026-09-30T12:00:00Z");
const at = (seconds: number) => new Date(now - seconds * 1000).toISOString();

it("announces finished tasks except user cancellations", () => {
  expect(attentionNotice({ taskId: "t", id: "5-0", event_type: "TASK_FINISHED",
    data: { status: "COMPLETED", timestamp: at(1) } }, now))
    .toEqual({ key: "t:5-0", title: "任务已完成", body: "回到 Bit Agent 查看结果和改动。" });
  expect(attentionNotice({ id: "6-0", event_type: "TASK_FINISHED", data: { status: "FAILED" } }, now)?.title)
    .toBe("任务未完成");
  expect(attentionNotice({ id: "7-0", event_type: "TASK_FINISHED", data: { status: "CANCELLED" } }, now)).toBeNull();
});

it("shows the first line of a question and marks approvals", () => {
  expect(attentionNotice({ id: "1-0", event_type: "USER_QUESTION", data: { timestamp: at(2),
    question: { question: "写入以下补丁\ndiff --git a/x b/x", requires_confirmation: true,
      operation: { title: "写入以下补丁" } } } }, now))
    .toMatchObject({ title: "需要你确认", body: "写入以下补丁" });
  expect(attentionNotice({ id: "2-0", event_type: "USER_QUESTION",
    data: { question: { question: "用哪个方案？", requires_confirmation: false } } }, now))
    .toMatchObject({ title: "Agent 在等你回答", body: "用哪个方案？" });
});

it("ignores replayed old events and unrelated events", () => {
  expect(attentionNotice({ id: "1-0", event_type: "TASK_FINISHED",
    data: { status: "COMPLETED", timestamp: at(600) } }, now)).toBeNull();
  expect(attentionNotice({ id: "1-0", event_type: "TOOL_COMPLETED", data: {} }, now)).toBeNull();
});
