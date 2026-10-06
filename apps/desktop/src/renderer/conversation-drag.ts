/** 同一工作区内通过原生 HTML 拖放调整对话顺序。 */
import { movedConversationOrder } from "./conversation-order";
import { conversationId, type TaskHistoryEntry } from "./task-history";
import { workspaceKey } from "./workspace-state";

export const conversationDragType = "application/x-bit-agent-conversation";
interface DragOptions { disabled: boolean; onReorder(root: string, ids: string[]): void }
interface DragSource { id: string; root: string; row: HTMLElement }
let source: DragSource | null = null;

function canDrop(entry: TaskHistoryEntry, options: DragOptions): boolean {
  return !options.disabled && source !== null && source.id !== conversationId(entry)
    && source.root === workspaceKey(entry.workspaceRoot);
}

function dropAfter(row: HTMLElement, event: DragEvent): boolean {
  const bounds = row.getBoundingClientRect();
  return event.clientY >= bounds.top + bounds.height / 2;
}

function clearMarkers(row: HTMLElement): void {
  delete row.dataset.dropPosition;
}

function startDrag(row: HTMLElement, entry: TaskHistoryEntry, options: DragOptions, event: DragEvent): void {
  if (options.disabled || (event.target instanceof Element && event.target.closest(".history-actions,input"))) {
    event.preventDefault();
    return;
  }
  source = { id: conversationId(entry), root: workspaceKey(entry.workspaceRoot), row };
  row.dataset.dragging = "true";
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(conversationDragType, source.id);
  }
}

function finishDrag(container: HTMLElement): void {
  if (source) delete source.row.dataset.dragging;
  source = null;
  for (const row of container.querySelectorAll<HTMLElement>("[data-drop-position]")) clearMarkers(row);
}

export function bindConversationDrag(row: HTMLElement, entry: TaskHistoryEntry,
  entries: TaskHistoryEntry[], options: DragOptions): void {
  row.dataset.conversationId = conversationId(entry);
  row.draggable = !options.disabled;
  row.addEventListener("dragstart", event => startDrag(row, entry, options, event));
  row.addEventListener("dragover", event => {
    if (!canDrop(entry, options)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    row.dataset.dropPosition = dropAfter(row, event) ? "after" : "before";
  });
  row.addEventListener("dragleave", () => clearMarkers(row));
  row.addEventListener("drop", event => {
    if (!canDrop(entry, options)) return;
    event.preventDefault();
    const ids = entries.map(conversationId);
    const order = movedConversationOrder(ids, source!.id, conversationId(entry), dropAfter(row, event));
    finishDrag(row.closest(".task-history") ?? row.parentElement ?? row);
    options.onReorder(entry.workspaceRoot, order);
  });
  row.addEventListener("dragend", () => finishDrag(row.closest(".task-history") ?? row.parentElement ?? row));
}
