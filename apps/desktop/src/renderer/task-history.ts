/** 侧边栏任务历史在本机 localStorage 中的保存格式与读写。 */
import type { MultiAgentMode } from "../shared/contracts";
import { object } from "./dom";

export interface TaskHistoryEntry {
  permissionMode?: "read_only" | "confirm" | "edit";
  taskId: string;
  objective: string;
  workspaceRoot: string;
  gatewayUrl: string;
  status: string;
  createdAt: string;
  finalAnswer?: string;
  sessionId?: string;
  multiAgentMode?: MultiAgentMode;
}

const historyKey = "bit-agent.task-history.v1";
export const maximumHistoryEntries = 200;

export function isHistoryEntry(value: unknown): value is TaskHistoryEntry {
  const record = object(value);
  return (
    typeof record?.taskId === "string" &&
    typeof record.objective === "string" &&
    typeof record.workspaceRoot === "string" &&
    typeof record.gatewayUrl === "string" &&
    typeof record.status === "string" &&
    typeof record.createdAt === "string"
  );
}

/** 读取失败或格式不对时返回空列表，不影响应用启动。 */
export function loadHistory(storage: Pick<Storage, "getItem"> = localStorage): TaskHistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(historyKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isHistoryEntry).slice(0, maximumHistoryEntries) : [];
  } catch {
    return [];
  }
}

export function saveHistory(
  history: TaskHistoryEntry[],
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(historyKey, JSON.stringify(history.slice(0, maximumHistoryEntries)));
}
