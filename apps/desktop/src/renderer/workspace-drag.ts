/** 仅拖动工作区标题调整侧栏位置，与其内部的对话拖放互相独立。 */
import { movedWorkspaceOrder } from "./workspace-order";
import { workspaceKey } from "./workspace-state";

export const workspaceDragType = "application/x-bit-agent-workspace";
interface DragOptions { disabled: boolean; onReorder(roots: string[]): void }
interface DragSource { root: string; header: HTMLElement }
let source: DragSource | null = null;

function canDrop(root: string, options: DragOptions, event: DragEvent): boolean {
  return !options.disabled && source !== null && source.root !== workspaceKey(root)
    && Array.from(event.dataTransfer?.types ?? []).includes(workspaceDragType);
}

function dropAfter(header: HTMLElement, event: DragEvent): boolean {
  const bounds = header.getBoundingClientRect();
  return event.clientY >= bounds.top + bounds.height / 2;
}

function finishDrag(header: HTMLElement): void {
  if (source) delete source.header.dataset.workspaceDragging;
  source = null;
  const container = header.closest(".task-history") ?? header.parentElement ?? header;
  for (const target of container.querySelectorAll<HTMLElement>("[data-workspace-drop-position]")) {
    delete target.dataset.workspaceDropPosition;
  }
}

function startDrag(header: HTMLElement, root: string, options: DragOptions, event: DragEvent): void {
  const target = event.target;
  if (options.disabled || (target instanceof Element && (target.closest(".workspace-group-action,input,.history-row")
    || target.closest(".workspace-group-header") !== header))) {
    event.preventDefault();
    return;
  }
  event.stopPropagation();
  source = { root: workspaceKey(root), header };
  header.dataset.workspaceDragging = "true";
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(workspaceDragType, source.root);
  }
}

export function bindWorkspaceDrag(header: HTMLElement, root: string, roots: string[], options: DragOptions): void {
  header.draggable = !options.disabled;
  header.addEventListener("dragstart", event => startDrag(header, root, options, event));
  header.addEventListener("dragover", event => {
    if (!canDrop(root, options, event)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    header.dataset.workspaceDropPosition = dropAfter(header, event) ? "after" : "before";
  });
  header.addEventListener("dragleave", () => { delete header.dataset.workspaceDropPosition; });
  header.addEventListener("drop", event => {
    if (!canDrop(root, options, event)) return;
    event.preventDefault(); event.stopPropagation();
    const order = movedWorkspaceOrder(roots, source!.root, root, dropAfter(header, event));
    finishDrag(header);
    options.onReorder(order);
  });
  header.addEventListener("dragend", event => {
    if (source?.header !== header) return;
    event.stopPropagation();
    finishDrag(header);
  });
}
