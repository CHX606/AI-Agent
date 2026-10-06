import { element,errorText,formatHistoryTime,object } from "../dom";
import { conversationId, mergeHistoryEntry, saveHistory,type TaskHistoryEntry } from "../task-history";
import { registerNewConversation, saveConversationOrder } from "../conversation-order";
import { saveWorkspaceOrder } from "../workspace-order";
import { renderWorkspaceTree } from "../workspace-tree";
import type { RendererApp } from "./context";
function renderHistory(app: RendererApp): void {
  const visible = app.searchResults ?? app.history;
  renderWorkspaceTree(app.taskHistory, {
    entries: visible,
    searching: app.searchResults !== null,
    activeWorkspace: app.activeWorkspaceRoot,
    disabled: app.submitting,
    renderEntry: app.historyRow,
    onNewConversation: app.newConversationIn,
    onReorder: (root, ids) => reorderHistory(app, root, ids),
    onWorkspaceReorder: roots => reorderWorkspaceHistory(app, roots),
    onChange: app.renderHistory,
  });
  // 标题旁的数字是工作区个数，悬停时显示对话数。
  app.historyCount.textContent = String(app.taskHistory.childElementCount);
  app.historyCount.title = `${app.taskHistory.childElementCount} 个工作区，${visible.length} 段对话`;
  app.historyEmpty.hidden = app.taskHistory.childElementCount > 0;
  app.historyEmpty.textContent = app.searchResults
    ? "没有找到匹配的对话。"
    : "点“添加工作区”选择一个本地代码仓库，对话会按工作区归类在这里。";
  app.workspaceChooser?.refresh();
}
function newConversationIn(app: RendererApp, root: string): void {
  if (app.submitting) return;
  app.resetTask();
  app.setWorkspace(root);
}
function reorderHistory(app: RendererApp, root: string, ids: string[]): void {
  try {
    saveConversationOrder(root, ids);
  } catch (error) {
    app.connectionDot.title = `保存对话顺序失败：${errorText(error)}`;
  }
  app.renderHistory();
}
function reorderWorkspaceHistory(app: RendererApp, roots: string[]): void {
  try {
    saveWorkspaceOrder(roots);
  } catch (error) {
    const message = `保存工作区顺序失败：${errorText(error)}`;
    app.connectionDot.title = message;
    throw new Error(message, { cause: error });
  }
  app.renderHistory();
}
function historyRow(app: RendererApp, entry: TaskHistoryEntry): HTMLElement {
  const row = document.createElement("div");
  row.className = "history-row";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "history-item";
  button.disabled = app.submitting;
  button.dataset.active = String(entry.taskId === app.activeTaskId);
  button.title = entry.objective;
  button.setAttribute("aria-description", formatHistoryTime(entry.createdAt));
  const icon = document.createElement("span");
  icon.className = "history-status";
  icon.dataset.status = entry.status;
  icon.setAttribute("aria-hidden", "true");
  const copy = document.createElement("span");
  copy.className = "history-copy";
  const title = document.createElement("strong");
  title.textContent = entry.objective;
  copy.append(title);
  button.append(icon, copy);
  button.addEventListener("click", () => void app.restoreTask(entry));
  row.append(button, historyActions(app, entry, title));
  return row;
}
function historyActions(app: RendererApp, entry: TaskHistoryEntry, title: HTMLElement): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "history-actions";
  for (const [action, label, svg] of [["rename", "重命名", app.renameIcon], ["delete", "删除", app.deleteIcon]] as const) {
    const control = document.createElement("button");
    control.type = "button";
    control.dataset.action = action;
    control.title = label;
    control.setAttribute("aria-label", `${label}对话：${entry.objective}`);
    control.innerHTML = svg;
    control.disabled = app.submitting;
    control.addEventListener("click", (event) => {
      event.stopPropagation();
      if (action === "rename") app.startRename(entry, title);
      else void app.deleteConversation(entry);
    });
    actions.append(control);
  }
  return actions;
}
function startRename(app: RendererApp, entry: TaskHistoryEntry, title: HTMLElement): void {
  const input = document.createElement("input");
  input.className = "history-rename";
  input.value = entry.objective;
  input.maxLength = 100;
  input.setAttribute("aria-label", "新的对话名称");
  title.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (save: boolean): Promise<void> => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    if (!save || !name || name === entry.objective) { app.renderHistory(); return; }
    try {
      if (entry.sessionId) {
        await window.bitAgent.renameSession({ gatewayUrl: app.gatewayUrl, sessionId: entry.sessionId, title: name });
      }
      app.history = app.history.map((item) => item.taskId === entry.taskId ? { ...item, objective: name } : item);
      app.searchResults = app.searchResults?.map((item) => item.taskId === entry.taskId ? { ...item, objective: name } : item) ?? null;
      saveHistory(app.history);
      if (entry.taskId === app.activeTaskId) app.taskIdText.textContent = name;
    } catch (error) {
      app.connectionDot.title = `重命名失败：${errorText(error)}`;
    }
    app.renderHistory();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); void finish(true); }
    else if (event.key === "Escape") { event.preventDefault(); void finish(false); }
  });
  input.addEventListener("blur", () => void finish(true));
}
async function deleteConversation(app: RendererApp, entry: TaskHistoryEntry): Promise<void> {
  if (!window.confirm(`删除对话“${entry.objective}”？\n\n会删除这段对话的全部记录和改动快照，无法恢复。项目里的文件不受影响。`)) return;
  try {
    if (entry.sessionId) {
      await window.bitAgent.deleteSession({ gatewayUrl: app.gatewayUrl, sessionId: entry.sessionId });
    }
  } catch (error) {
    app.connectionDot.title = `删除失败：${errorText(error)}`;
    return;
  }
  const removed = (item: TaskHistoryEntry) => item.taskId === entry.taskId
    || (entry.sessionId !== undefined && item.sessionId === entry.sessionId && item.gatewayUrl === entry.gatewayUrl);
  app.history = app.history.filter((item) => !removed(item));
  app.searchResults = app.searchResults?.filter((item) => !removed(item)) ?? null;
  saveHistory(app.history);
  if ((entry.sessionId && entry.sessionId === app.activeSessionId) || entry.taskId === app.activeTaskId) app.resetTask();
  else app.renderHistory();
}
async function searchSessions(app: RendererApp, query: string): Promise<void> {
  const sequence = ++app.searchSequence;
  if (!query) { app.searchResults = null; app.renderHistory(); return; }
  const gatewayUrl = app.gatewayUrl;
  const local = app.history.filter((entry) => !entry.sessionId && entry.objective.includes(query));
  try {
    const payload = await window.bitAgent.listSessions(gatewayUrl, 0, query);
    if (sequence !== app.searchSequence) return;
    app.searchResults = [...app.sessionEntries(payload, gatewayUrl), ...local];
  } catch {
    if (sequence !== app.searchSequence) return;
    app.searchResults = app.history.filter((entry) => entry.objective.includes(query));
  }
  app.renderHistory();
}
function upsertHistory(app: RendererApp, entry: TaskHistoryEntry): void {
  if (!app.history.some(item => conversationId(item) === conversationId(entry))) {
    try {
      registerNewConversation(entry);
    } catch (error) {
      app.connectionDot.title = `保存对话顺序失败：${errorText(error)}`;
    }
  }
  app.history = mergeHistoryEntry(app.history, entry);
  saveHistory(app.history);
  app.renderHistory();
}
function updateActiveHistory(app: RendererApp, update: Partial<TaskHistoryEntry>): void {
  if (!app.activeTaskId) return;
  const current = app.history.find((item) => item.taskId === app.activeTaskId);
  if (!current) return;
  app.upsertHistory({ ...current, ...update });
}
function sessionEntries(app: RendererApp, payload: Record<string, unknown>, gatewayUrl: string): TaskHistoryEntry[] {
  const loaded: TaskHistoryEntry[] = [];
  for (const raw of Array.isArray(payload.sessions) ? payload.sessions : []) {
    const session = object(raw);
    const task = object(session?.latest_task);
    if (typeof session?.session_id !== "string" || typeof task?.task_id !== "string") continue;
    loaded.push({
      taskId: task.task_id, sessionId: session.session_id,
      objective: String(session.title ?? task.objective ?? "对话"),
      workspaceRoot: String(session.workspace_root ?? ""), gatewayUrl,
      status: String(task.status ?? "UNKNOWN"),
      createdAt: String(task.created_at ?? session.created_at ?? ""),
      activityAt: String(task.created_at ?? session.created_at ?? ""),
      multiAgentMode: session.multi_agent_mode === "on" || session.multi_agent_mode === "off"
        ? session.multi_agent_mode : "auto",
    });
  }
  return loaded;
}
async function refreshSessions(app: RendererApp, append = false): Promise<void> {
  const gatewayUrl = app.gatewayUrl;
  const offset = append ? app.nextSessionOffset : 0;
  if (offset === null) return;
  const payload = await window.bitAgent.listSessions(gatewayUrl, offset);
  if (gatewayUrl !== app.gatewayUrl) return;
  app.nextSessionOffset = typeof payload.next_offset === "number" ? payload.next_offset : null;
  element<HTMLButtonElement>("#more-sessions").hidden = app.nextSessionOffset === null || app.searchResults !== null;
  if (!Array.isArray(payload.sessions)) return;
  const loaded = app.sessionEntries(payload, gatewayUrl).map(entry => {
    const prior = app.history.find(item => item.sessionId === entry.sessionId);
    return prior ? mergeHistoryEntry([prior], entry)[0]! : entry;
  });
  const identifiers = new Set(loaded.map(conversationId));
  const remaining = app.history.filter(entry => !identifiers.has(conversationId(entry)));
  app.history = append ? [...remaining, ...loaded] : [...loaded, ...remaining];
  saveHistory(app.history);
  app.renderHistory();
}
export function createHistoryController(app: RendererApp) {
  return {
    renderHistory: renderHistory.bind(null, app),
    newConversationIn: newConversationIn.bind(null, app),
    historyRow: historyRow.bind(null, app),
    startRename: startRename.bind(null, app),
    deleteConversation: deleteConversation.bind(null, app),
    searchSessions: searchSessions.bind(null, app),
    upsertHistory: upsertHistory.bind(null, app),
    updateActiveHistory: updateActiveHistory.bind(null, app),
    sessionEntries: sessionEntries.bind(null, app),
    refreshSessions: refreshSessions.bind(null, app),
  };
}

