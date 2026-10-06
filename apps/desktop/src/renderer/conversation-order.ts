/** 对话的默认消息时间排序与每个工作区的手动顺序。 */
import { conversationId, type TaskHistoryEntry } from "./task-history";
import { workspaceKey } from "./workspace-state";

export const conversationOrderPrefix = "bit-agent.conversation-order.v1:";

function orderKey(root: string): string { return conversationOrderPrefix + workspaceKey(root); }

function storedOrder(root: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(orderKey(root)) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

function activityTime(entry: TaskHistoryEntry): number {
  const value = Date.parse(entry.activityAt ?? entry.createdAt);
  return Number.isNaN(value) ? 0 : value;
}

export function orderedConversations(entries: TaskHistoryEntry[]): TaskHistoryEntry[] {
  const recent = [...entries].sort((left, right) => activityTime(right) - activityTime(left));
  const saved = storedOrder(entries[0]?.workspaceRoot ?? "");
  if (!saved.length) return recent;
  const positions = new Map(saved.map((id, position) => [id, position]));
  const remaining = recent.filter(entry => !positions.has(conversationId(entry)));
  const existing = recent.filter(entry => positions.has(conversationId(entry)));
  existing.sort((left, right) => positions.get(conversationId(left))! - positions.get(conversationId(right))!);
  return [...existing, ...remaining];
}

export function saveConversationOrder(root: string, ids: string[]): void {
  localStorage.setItem(orderKey(root), JSON.stringify([...new Set(ids)]));
}

/** 只由创建对话入口调用；分页加载的旧会话不会被登记到最前。 */
export function registerNewConversation(entry: TaskHistoryEntry): void {
  const saved = storedOrder(entry.workspaceRoot);
  const id = conversationId(entry);
  if (!saved.length || saved.includes(id)) return;
  saveConversationOrder(entry.workspaceRoot, [id, ...saved]);
}

export function movedConversationOrder(ids: string[], source: string, target: string, after: boolean): string[] {
  if (source === target || !ids.includes(source) || !ids.includes(target)) return [...ids];
  const remaining = ids.filter(id => id !== source);
  const position = remaining.indexOf(target) + Number(after);
  remaining.splice(position, 0, source);
  return remaining;
}
