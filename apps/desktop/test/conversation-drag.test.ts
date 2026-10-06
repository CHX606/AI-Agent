import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindConversationDrag, conversationDragType } from "../src/renderer/conversation-drag";
import type { TaskHistoryEntry } from "../src/renderer/task-history";

class DragRow {
  dataset: Record<string, string> = {};
  draggable = false;
  parentElement: DragRow | null = null;
  listeners = new Map<string, (event: DragEvent) => void>();
  addEventListener(name: string, listener: (event: DragEvent) => void): void { this.listeners.set(name, listener); }
  getBoundingClientRect(): { top: number; height: number } { return { top: 10, height: 30 }; }
  closest(): null { return null; }
  querySelectorAll(): DragRow[] { return [this]; }
  fire(name: string, clientY = 15) {
    const event = {
      target: null, clientY, preventDefault: vi.fn(),
      dataTransfer: { effectAllowed: "", dropEffect: "", setData: vi.fn() },
    };
    this.listeners.get(name)?.(event as unknown as DragEvent);
    return event;
  }
}
const entry = (id: string, workspaceRoot = "D:/project"): TaskHistoryEntry => ({
  taskId: id, sessionId: id, objective: id, workspaceRoot, createdAt: "2026-10-04T10:00:00Z",
  gatewayUrl: "http://127.0.0.1:3000", status: "COMPLETED",
});
const bind = (row: DragRow, value: TaskHistoryEntry, entries: TaskHistoryEntry[], disabled = false) => {
  const onReorder = vi.fn();
  bindConversationDrag(row as unknown as HTMLElement, value, entries, { disabled, onReorder });
  return onReorder;
};
beforeEach(() => vi.stubGlobal("Element", DragRow));
afterEach(() => vi.unstubAllGlobals());

describe("workspace conversation drag interaction", () => {
  it("performs a same-workspace drop and exposes persisted conversation identity", () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const start = new DragRow();
    const target = new DragRow();
    bind(start, entries[2]!, entries);
    const reordered = bind(target, entries[0]!, entries);
    const event = start.fire("dragstart");
    expect(start.dataset.conversationId).toBe("session:c");
    expect(event.dataTransfer.setData).toHaveBeenCalledWith(conversationDragType, "session:c");
    expect(target.fire("dragover").preventDefault).toHaveBeenCalled();
    expect(target.dataset.dropPosition).toBe("before");
    target.fire("drop");
    expect(reordered).toHaveBeenCalledWith("D:/project", ["session:c", "session:a", "session:b"]);
    expect(start.dataset.dragging).toBeUndefined();
    expect(target.dataset.dropPosition).toBeUndefined();
  });

  it("rejects cross-workspace drops", () => {
    const first = entry("a");
    const other = entry("b", "E:/different");
    const start = new DragRow();
    const target = new DragRow();
    bind(start, first, [first]);
    const reordered = bind(target, other, [other]);
    start.fire("dragstart");
    expect(target.fire("dragover").preventDefault).not.toHaveBeenCalled();
    target.fire("drop");
    expect(reordered).not.toHaveBeenCalled();
    start.fire("dragend");
  });

  it("disables drag starts and drops while submitting or searching", () => {
    const entries = [entry("a"), entry("b")];
    const disabled = new DragRow();
    const reordered = bind(disabled, entries[1]!, entries, true);
    expect(disabled.draggable).toBe(false);
    expect(disabled.fire("dragstart").preventDefault).toHaveBeenCalled();
    const start = new DragRow();
    bind(start, entries[0]!, entries);
    start.fire("dragstart");
    disabled.fire("drop");
    expect(reordered).not.toHaveBeenCalled();
    start.fire("dragend");
  });

  it("does not accept an external drop without an internal source", () => {
    const row = new DragRow();
    const value = entry("a");
    const reordered = bind(row, value, [value]);
    row.fire("drop");
    expect(reordered).not.toHaveBeenCalled();
  });
});
