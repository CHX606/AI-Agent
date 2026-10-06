import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { movedConversationOrder, orderedConversations, registerNewConversation, saveConversationOrder } from "../src/renderer/conversation-order";
import { conversationId, mergeHistoryEntry, type TaskHistoryEntry } from "../src/renderer/task-history";
import { knownWorkspaces, rememberWorkspace } from "../src/renderer/workspace-state";

const entry = (id: string, activityAt: string, workspaceRoot = "D:/project"): TaskHistoryEntry => ({
  taskId: `task-${id}`, sessionId: id, objective: id, workspaceRoot, activityAt,
  createdAt: activityAt, gatewayUrl: "http://127.0.0.1:3000", status: "COMPLETED",
});
let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("conversation activity and manual order", () => {
  it("sorts by actual conversation activity rather than the input array or selected item", () => {
    const old = entry("old", "2026-10-04T10:00:00Z");
    const recent = entry("recent", "2026-10-04T12:00:00Z");
    expect(orderedConversations([old, recent]).map(conversationId)).toEqual(["session:recent", "session:old"]);
    const updated = mergeHistoryEntry([recent, old], { ...old, status: "CANCELLED" });
    expect(updated.map(conversationId)).toEqual(["session:recent", "session:old"]);
    expect(orderedConversations(updated).map(conversationId)).toEqual(["session:recent", "session:old"]);
  });

  it("moves the default order only when a new conversation message arrives", () => {
    const older = entry("old", "2026-10-04T10:00:00Z");
    const newer = entry("new", "2026-10-04T12:00:00Z");
    const continued = { ...older, taskId: "next-turn", activityAt: "2026-10-04T13:00:00Z" };
    const updated = mergeHistoryEntry([newer, older], continued);
    expect(updated).toHaveLength(2);
    expect(orderedConversations(updated).map(conversationId)).toEqual(["session:old", "session:new"]);
  });

  it("keeps a saved workspace order across refreshed tasks and adds a new conversation at the front", () => {
    const a = entry("a", "2026-10-04T12:00:00Z");
    const b = entry("b", "2026-10-04T10:00:00Z");
    saveConversationOrder("d:\\PROJECT\\", [conversationId(b), conversationId(a)]);
    expect(orderedConversations([a, b]).map(conversationId)).toEqual(["session:b", "session:a"]);
    const nextTurn = { ...a, taskId: "another-task", activityAt: "2026-10-04T14:00:00Z" };
    const fresh = entry("fresh", "2026-10-04T13:00:00Z");
    registerNewConversation(fresh);
    expect(orderedConversations([nextTurn, b, fresh]).map(conversationId))
      .toEqual(["session:fresh", "session:b", "session:a"]);
  });

  it("appends older pagination entries without disturbing the manual order", () => {
    const a = entry("a", "2026-10-04T12:00:00Z");
    const b = entry("b", "2026-10-04T10:00:00Z");
    const older = entry("older-page", "2026-10-03T10:00:00Z");
    saveConversationOrder(a.workspaceRoot, [conversationId(b), conversationId(a)]);
    expect(orderedConversations([older, a, b]).map(conversationId))
      .toEqual(["session:b", "session:a", "session:older-page"]);
  });

  it("keeps each workspace independent and ignores corrupt stored order", () => {
    saveConversationOrder("E:/other", ["session:b", "session:a"]);
    const entries = [entry("b", "2026-10-04T10:00:00Z"), entry("a", "2026-10-04T12:00:00Z")];
    expect(orderedConversations(entries).map(conversationId)).toEqual(["session:a", "session:b"]);
    values.set("bit-agent.conversation-order.v1:d:/project", "{");
    expect(orderedConversations(entries).map(conversationId)).toEqual(["session:a", "session:b"]);
  });

  it("preserves a later local supplement timestamp through session refresh", () => {
    const local = entry("a", "2026-10-04T13:00:00Z");
    const remote = { ...entry("a", "2026-10-04T12:00:00Z"), gatewayUrl: "http://127.0.0.1:54321" };
    expect(mergeHistoryEntry([local], remote)).toEqual([{ ...remote, activityAt: local.activityAt }]);
  });

  it("compares activity instants across equivalent timezone formats", () => {
    const local = entry("a", "2026-10-04T13:00:00.000Z");
    const remote = entry("a", "2026-10-04T12:59:59.999+00:00");
    expect(mergeHistoryEntry([local], remote)[0]?.activityAt).toBe(local.activityAt);
  });

  it("moves before and after a target without changing other conversations", () => {
    expect(movedConversationOrder(["a", "b", "c"], "c", "a", false)).toEqual(["c", "a", "b"]);
    expect(movedConversationOrder(["a", "b", "c"], "a", "b", true)).toEqual(["b", "a", "c"]);
    expect(movedConversationOrder(["a", "b"], "a", "a", false)).toEqual(["a", "b"]);
  });

  it("opening another known workspace does not move its group", () => {
    rememberWorkspace("D:/first");
    rememberWorkspace("E:/second");
    rememberWorkspace("d:\\FIRST\\");
    expect(knownWorkspaces()).toEqual(["D:/first", "E:/second"]);
  });
});
