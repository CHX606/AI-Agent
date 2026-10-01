import type { TaskEvent } from "../../shared/contracts.js";

export interface AttentionNotice {
  key: string;
  title: string;
  body: string;
}

/** 断线重连会从头重放事件；超过这个时间的旧事件不再提醒。 */
const MAX_EVENT_AGE_MS = 60_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>) : null;
}

/**
 * 窗口不在前台时，哪些事件值得提醒用户：任务结束（用户自己取消的除外），
 * 以及 Agent 提问或等待批准。
 */
export function attentionNotice(event: TaskEvent, now = Date.now()): AttentionNotice | null {
  const data = record(event.data);
  if (!data) return null;
  const timestamp = typeof data.timestamp === "string" ? Date.parse(data.timestamp) : NaN;
  if (Number.isFinite(timestamp) && now - timestamp > MAX_EVENT_AGE_MS) return null;
  const key = `${event.taskId ?? ""}:${event.id ?? event.event_type}`;
  if (event.event_type === "TASK_FINISHED") {
    const titles: Record<string, string> = {
      COMPLETED: "任务已完成", PARTIAL: "任务部分完成", FAILED: "任务未完成",
    };
    const title = titles[String(data.status)];
    return title ? { key, title, body: "回到 Bit Agent 查看结果和改动。" } : null;
  }
  if (event.event_type === "USER_QUESTION") {
    const question = record(data.question);
    if (!question) return null;
    const text = String(question.question ?? "").split("\n")[0]?.trim() ?? "";
    return {
      key,
      title: question.operation || question.requires_confirmation ? "需要你确认" : "Agent 在等你回答",
      body: text.length > 120 ? `${text.slice(0, 120)}…` : text || "回到 Bit Agent 查看问题。",
    };
  }
  return null;
}
