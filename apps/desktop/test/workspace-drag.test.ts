import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindWorkspaceDrag, workspaceDragType } from "../src/renderer/workspace-drag";
import { bindConversationDrag, conversationDragType } from "../src/renderer/conversation-drag";
import type { TaskHistoryEntry } from "../src/renderer/task-history";

type Transfer = { types: string[]; effectAllowed: string; dropEffect: string; setData: ReturnType<typeof vi.fn> };
const transfer = (): Transfer => {
  const value: Transfer = { types: [], effectAllowed: "", dropEffect: "", setData: vi.fn() };
  value.setData.mockImplementation((type: string) => { value.types.push(type); });
  return value;
};
let elements: DragElement[];
class DragElement {
  dataset: Record<string, string> = {};
  draggable = false;
  parentElement: DragElement | null = null;
  header: DragElement | null = null;
  role: "header" | "action" | "conversation" = "header";
  listeners = new Map<string, (event: DragEvent) => void>();
  constructor() { elements.push(this); }
  addEventListener(name: string, listener: (event: DragEvent) => void): void { this.listeners.set(name, listener); }
  getBoundingClientRect() { return { top: 10, height: 30 }; }
  closest(selector: string): DragElement | null {
    if (selector === ".workspace-group-header") return this.role === "header" ? this : this.header;
    if (selector.includes(".workspace-group-action") && this.role === "action") return this;
    if (selector.includes(".history-row") && this.role === "conversation") return this;
    return null;
  }
  querySelectorAll(): DragElement[] { return elements; }
  fire(name: string, dataTransfer = transfer(), clientY = 15, target: DragElement = this) {
    const event = { target, dataTransfer, clientY, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    this.listeners.get(name)?.(event as unknown as DragEvent);
    return event;
  }
}
const bind = (header: DragElement, root: string, roots: string[], disabled = false) => {
  const onReorder = vi.fn();
  bindWorkspaceDrag(header as unknown as HTMLElement, root, roots, { disabled, onReorder });
  return onReorder;
};
beforeEach(() => { elements = []; vi.stubGlobal("Element", DragElement); });
afterEach(() => { for (const element of elements) element.fire("dragend"); vi.unstubAllGlobals(); });

describe("workspace header drag", () => {
  it("reorders groups before a target and clears the drag source before rerender", () => {
    const roots = ["D:/a", "E:/b", "F:/c"], first = new DragElement(), last = new DragElement();
    const reordered = bind(first, roots[0]!, roots); bind(last, roots[2]!, roots);
    const data = transfer(), start = last.fire("dragstart", data);
    expect(data.setData).toHaveBeenCalledWith(workspaceDragType, "f:/c");
    expect(start.stopPropagation).toHaveBeenCalled();
    expect(first.fire("dragover", data).preventDefault).toHaveBeenCalled();
    expect(first.dataset.workspaceDropPosition).toBe("before");
    expect(first.fire("drop", data).stopPropagation).toHaveBeenCalled();
    expect(reordered).toHaveBeenCalledWith(["F:/c", "D:/a", "E:/b"]);
    expect(last.dataset.workspaceDragging).toBeUndefined();
    expect(first.dataset.workspaceDropPosition).toBeUndefined();
    first.fire("drop", data);
    expect(reordered).toHaveBeenCalledTimes(1);
  });

  it("uses the lower half of a header to insert after that entire group", () => {
    const roots = ["D:/a", "E:/b", "F:/c"], first = new DragElement(), target = new DragElement();
    bind(first, roots[0]!, roots); const reordered = bind(target, roots[1]!, roots);
    const data = transfer(); first.fire("dragstart", data); target.fire("dragover", data, 35);
    expect(target.dataset.workspaceDropPosition).toBe("after");
    target.fire("drop", data, 35);
    expect(reordered).toHaveBeenCalledWith(["E:/b", "D:/a", "F:/c"]);
  });

  it("disables starts and drops while submitting or searching", () => {
    const roots = ["D:/a", "E:/b"], first = new DragElement(), target = new DragElement();
    bind(first, roots[0]!, roots); const reordered = bind(target, roots[1]!, roots, true);
    expect(target.draggable).toBe(false);
    expect(target.fire("dragstart").preventDefault).toHaveBeenCalled();
    const data = transfer(); first.fire("dragstart", data); target.fire("drop", data);
    expect(reordered).not.toHaveBeenCalled();
  });

  it("keeps plus/remove buttons and ordinary clicks independent of drag", () => {
    const header = new DragElement(), action = new DragElement(); action.role = "action"; action.header = header;
    bind(header, "D:/a", ["D:/a"]);
    const click = vi.fn(); header.addEventListener("click", click);
    const data = transfer();
    expect(header.fire("dragstart", data, 15, action).preventDefault).toHaveBeenCalled();
    expect(data.setData).not.toHaveBeenCalled();
    header.fire("click"); expect(click).toHaveBeenCalledOnce();
  });

  it("rejects external drops, same-group drops, and conversation events bubbled to a header", () => {
    const roots = ["D:/a", "E:/b"], header = new DragElement(), target = new DragElement(), child = new DragElement();
    child.role = "conversation";
    bind(header, roots[0]!, roots); const reordered = bind(target, roots[1]!, roots);
    const external = transfer(); external.types.push(workspaceDragType);
    target.fire("drop", external); expect(reordered).not.toHaveBeenCalled();
    expect(header.fire("dragstart", transfer(), 15, child).preventDefault).toHaveBeenCalled();
    const data = transfer(); header.fire("dragstart", data);
    expect(header.fire("dragover", data).preventDefault).not.toHaveBeenCalled();
    target.fire("drop", transfer()); expect(reordered).not.toHaveBeenCalled();
  });

  it("still permits conversation drag without rearranging workspace groups", () => {
    const roots = ["D:/a", "E:/b"], header = new DragElement(), first = new DragElement(), second = new DragElement();
    first.role = second.role = "conversation";
    const reorderedWorkspace = bind(header, roots[1]!, roots), reorderedConversation = vi.fn();
    const entry = (id: string): TaskHistoryEntry => ({ taskId:id, objective:id, workspaceRoot:roots[0]!,
      createdAt:"2026-10-04T10:00:00Z", gatewayUrl:"http://127.0.0.1:3000", status:"COMPLETED" });
    const entries = [entry("first"), entry("second")];
    bindConversationDrag(first as unknown as HTMLElement, entries[0]!, entries, { disabled:false, onReorder:reorderedConversation });
    bindConversationDrag(second as unknown as HTMLElement, entries[1]!, entries, { disabled:false, onReorder:reorderedConversation });
    const data = transfer(); second.fire("dragstart", data);
    expect(data.types).toContain(conversationDragType);
    header.fire("drop", data); expect(reorderedWorkspace).not.toHaveBeenCalled();
    first.fire("drop", data);
    expect(reorderedConversation).toHaveBeenCalledWith("D:/a", ["task:second", "task:first"]);
    second.fire("dragend", data);
  });

  it("does not hide a failure reported by the persistence callback", () => {
    const roots = ["D:/a", "E:/b"], first = new DragElement(), target = new DragElement();
    bind(first, roots[0]!, roots);
    bindWorkspaceDrag(target as unknown as HTMLElement, roots[1]!, roots,
      { disabled:false, onReorder:() => { throw new Error("storage full"); } });
    const data = transfer(); first.fire("dragstart", data);
    expect(() => target.fire("drop", data)).toThrow("storage full");
    expect(first.dataset.workspaceDragging).toBeUndefined();
  });
});
