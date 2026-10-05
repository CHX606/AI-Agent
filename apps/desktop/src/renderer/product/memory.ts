import type { LongTermMemory } from "../../shared/contracts.js";
import { createMemoryEntry } from "../memory-panel.js";
import type { ProductDialog } from "./dialog.js";

type MemoryContext = { gatewayUrl: string; workspaceRoot: string };
interface MemoryView {
  dialog: ProductDialog; body: HTMLElement; context: MemoryContext;
  showAll: HTMLInputElement; count: HTMLElement; list: HTMLElement;
}

function paintEmpty(view: MemoryView, enabled: boolean, all: boolean): void {
  const empty = document.createElement("p");
  empty.className = "product-empty";
  empty.textContent = !enabled
    ? "长期记忆已关闭。去掉环境变量 BIT_AGENT_LONG_TERM_MEMORY=0 后重新启动应用即可开启。"
    : all ? "还没有记忆。完成一个通过独立验收的修改任务后，这里会出现提炼出的经验。"
      : "这个项目还没有记忆。可以勾选“显示所有项目”查看其他项目。";
  view.list.append(empty);
}

async function removeMemory(view: MemoryView, memory: LongTermMemory, button: HTMLButtonElement): Promise<void> {
  if (!window.confirm(`删除这条记忆？\n\n${memory.title}\n\n删除后，新任务不会再参考它。`)) return;
  button.disabled = true;
  try {
    await window.bitAgent.deleteMemory({ gatewayUrl: view.context.gatewayUrl, memoryId: memory.id });
    await drawMemories(view);
  } catch (error) {
    button.disabled = false;
    view.dialog.feedback(view.body, error);
  }
}

async function drawMemories(view: MemoryView): Promise<void> {
  const all = view.showAll.checked;
  try {
    const result = await window.bitAgent.listMemories({ gatewayUrl: view.context.gatewayUrl,
      ...(all ? {} : { workspaceRoot: view.context.workspaceRoot }) });
    if (!view.dialog.active(view.body)) return;
    view.dialog.ready(view.body);
    view.list.replaceChildren();
    const memories = result.enabled ? result.memories : [];
    view.count.textContent = result.enabled ? `${memories.length} 条` : "";
    if (!result.enabled || !memories.length) { paintEmpty(view, result.enabled, all); return; }
    for (const memory of memories) {
      view.list.append(createMemoryEntry(memory, all, (button) => removeMemory(view, memory, button)));
    }
  } catch (error) { view.dialog.feedback(view.body, error); }
}

export async function showMemories(dialog: ProductDialog, current: () => MemoryContext): Promise<void> {
  const body = dialog.open("memory", "长期记忆",
    "通过独立验收的任务会自动提炼经验，只保存在本机；新任务开始前按关键词召回本项目的相关经验。");
  const context = current();
  const toolbar = document.createElement("div");
  toolbar.className = "memory-toolbar";
  const scope = document.createElement("label");
  scope.className = "memory-scope";
  const showAll = document.createElement("input");
  showAll.type = "checkbox";
  showAll.id = "memory-show-all";
  // 没选工作区时只能看全部项目。
  showAll.checked = !context.workspaceRoot;
  showAll.disabled = !context.workspaceRoot;
  scope.append(showAll, document.createTextNode("显示所有项目"));
  const count = document.createElement("span");
  count.className = "memory-count";
  toolbar.append(scope, count);
  const list = document.createElement("div");
  list.className = "memory-list";
  list.setAttribute("aria-live", "polite");
  body.append(toolbar, list);
  const view = { dialog, body, context, showAll, count, list };
  showAll.onchange = () => { void drawMemories(view); };
  await drawMemories(view);
}
