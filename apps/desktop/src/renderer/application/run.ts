import { object } from "../dom";
import { permissionMode } from "../product-controls";
import {
clearPreviousTurns,getAgentMode,
renderPreviousTurns,setAgentMode
} from "../session-view";
import { type TaskHistoryEntry } from "../task-history";
import { taskWorkspaceRoot } from "../workspace-options";
import type { RendererApp } from "./context";

function prepareRun(app: RendererApp, objective: string, title = objective): void {
  app.interactionView?.reset();
  app.stoppedTaskId = null;
  app.replaying = false;
  app.activeObjective = objective;
  // 顶部显示对话名（和左侧列表一致），不是最新一句话。
  app.taskIdText.textContent = title;
  app.taskIdText.removeAttribute("title");
  app.errorActions.hidden = true;
  app.streamView.reset();
  app.showConversation(objective);
  app.resetMetrics();
  app.setBusy(true);
  app.setStatus("SUBMITTING");
}

async function steer(app: RendererApp, mode: "supplement" | "answer"): Promise<void> {
  const text = app.objectiveInput.value.trim();
  if (!text || !app.interactionView || app.submitting) return;
  const approval = app.interactionView.pendingKind() === "approval";
  app.submitting = true;
  app.paintComposer();
  try {
    const sent = mode === "answer" ? await app.interactionView.answer(text) : await app.interactionView.supplement(text);
    if (sent) {
      app.objectiveInput.value = "";
      app.streamView.userNote(mode === "answer" && approval ? `不批准：${text}` : text);
    }
  } finally {
    app.submitting = false;
    app.paintComposer();
  }
}

async function runAgent(app: RendererApp, text?: string): Promise<void> {
  const composer = app.composerMode();
  if (text === undefined && (composer === "supplement" || composer === "answer")) { await app.steer(composer); return; }
  if (app.submitting || document.body.dataset.busy === "true") return;
  const objective = (text ?? app.objectiveInput.value).trim();
  let workspaceRoot: string;
  try {
    if (!objective) throw new Error("请填写任务描述");
    workspaceRoot = taskWorkspaceRoot(app.workspaceInput.value, app.activeSessionId ? app.activeWorkspaceRoot : null);
  } catch (error) {
    app.showError(error);
    app.workspaceChooser?.focus();
    return;
  }
  app.activeObjective = objective;
  if (text === undefined) app.objectiveInput.value = "";
  await submitRun(app, objective, workspaceRoot);
}

async function submitRun(app: RendererApp, objective: string, workspaceRoot: string): Promise<void> {
  const previousSession = app.activeSessionId;
  const mode = getAgentMode();
  if (app.activeTaskId) window.bitAgent.unwatchTask(app.activeTaskId);
  // 继续同一对话时，上一轮已经画好的过程原样留在页面上，不折叠成只剩回答。
  if (previousSession && app.activeTaskId) app.keepProcess(app.activeTaskId, app.streamView.detach());
  app.activeTaskId = null;
  const generation = ++app.viewGeneration;
  app.submitting = true;
  const title = previousSession
    ? app.history.find((item) => item.sessionId === previousSession && item.gatewayUrl === app.gatewayUrl)?.objective
    : undefined;
  app.prepareRun(objective, title ?? objective);
  try {
    if (previousSession) {
      const saved = await window.bitAgent.getSession({ gatewayUrl: app.gatewayUrl, sessionId: previousSession });
      renderPreviousTurns(saved, null, app.previousTurnOptions());
      app.streamView.scrollToEnd();
    }
    await createAndWatch(app, objective, workspaceRoot, previousSession, mode, generation);
  } catch (error) {
    app.showError(error);
    app.objectiveInput.value = objective;
  } finally {
    app.submitting = false;
    app.setBusy(document.body.dataset.busy === "true");
  }
}

async function createAndWatch(app: RendererApp, objective: string, workspaceRoot: string,
  previousSession: string | null, mode: ReturnType<typeof getAgentMode>, generation: number): Promise<void> {
    const task = await window.bitAgent.createTask({
      gatewayUrl: app.gatewayUrl,
      objective,
      workspaceRoot,
      ...(previousSession ? { sessionId: previousSession } : {}),
      multiAgentMode: mode,
      permissionMode: permissionMode(),
      ...(app.modelMenu?.selection() ?? {}),
    });
    if (generation !== app.viewGeneration) return;
    if (typeof task.task_id !== "string") throw new Error("Gateway 没有返回 task_id");
    app.activeTaskId = task.task_id;
    app.activeSessionId = typeof task.session_id === "string" ? task.session_id : null;
    app.interactionView?.update(task);
    app.taskIdText.title = `任务 ID：${app.activeTaskId}`;
    const status = typeof task.status === "string" ? task.status : "QUEUED";
    recordCreatedTask(app, objective, workspaceRoot, previousSession, mode, status);
    app.setStatus(status);
    window.bitAgent.watchTask(app.requestInput());
}

function recordCreatedTask(app: RendererApp, objective: string, workspaceRoot: string,
  previousSession: string | null, mode: ReturnType<typeof getAgentMode>, status: string): void {
    app.activeWorkspaceRoot = workspaceRoot;
    // 继续已有对话时保留它的标题，不用最新一句话覆盖。
    const existing = previousSession
      ? app.history.find((item) => item.sessionId === previousSession && item.gatewayUrl === app.gatewayUrl)
      : undefined;
    app.upsertHistory({
      taskId: app.requestInput().taskId,
      objective: existing?.objective ?? objective,
      workspaceRoot,
      gatewayUrl: app.gatewayUrl,
      status,
      createdAt: new Date().toISOString(),
      ...(app.activeSessionId ? { sessionId: app.activeSessionId } : {}),
      multiAgentMode: mode,
      permissionMode: permissionMode(),
    });
}

async function restoreTask(app: RendererApp, entry: TaskHistoryEntry): Promise<void> {
  if (app.submitting || entry.taskId === app.activeTaskId) return;
  const generation = prepareRestore(app, entry);
  try {
    const input = { gatewayUrl: app.gatewayUrl, taskId: entry.taskId };
    if (entry.sessionId) {
      const saved = await window.bitAgent.getSession({ gatewayUrl: app.gatewayUrl, sessionId: entry.sessionId });
      if (generation !== app.viewGeneration) return;
      renderPreviousTurns(saved, entry.taskId, app.previousTurnOptions());
      app.streamView.scrollToEnd();
      setAgentMode(object(saved.session)?.multi_agent_mode);
    }
    const task = await window.bitAgent.getTask(input);
    if (generation !== app.viewGeneration) return;
    if (typeof task.objective === "string") {
      app.activeObjective = task.objective;
      app.objectiveDisplay.textContent = task.objective;
    }
    app.interactionView?.update(task);
    const status = typeof task.status === "string" ? task.status : entry.status;
    app.streamView.setStartedAt(typeof task.started_at === "string" ? task.started_at : null);
    if (app.terminalStatuses.has(status)) {
      // 已结束的任务：回放保存的事件，重建完整的过程；回放结束后再载入最终结果。
      app.replaying = true;
      app.setStatus(status);
      window.bitAgent.watchTask(app.requestInput());
    } else {
      app.streamView.setLoading(null);
      app.setStatus(status);
      app.setBusy(true);
      window.bitAgent.watchTask(app.requestInput());
    }
  } catch (error) {
    if (generation !== app.viewGeneration) return;
    app.showError(error);
  }
}

function prepareRestore(app: RendererApp, entry: TaskHistoryEntry): number {
  if (app.activeTaskId) window.bitAgent.unwatchTask(app.activeTaskId);
  const generation = ++app.viewGeneration;
  app.activeSessionId = null;
  app.setWorkspace(entry.workspaceRoot);
  app.activeTaskId = entry.taskId;
  app.stoppedTaskId = app.stoppedTasks.has(entry.taskId) ? entry.taskId : null;
  app.activeSessionId = entry.sessionId ?? null;
  app.activeObjective = entry.objective;
  app.objectiveInput.value = "";
  setAgentMode(entry.multiAgentMode);
  app.dropProcesses();
  app.clearQueue();
  clearPreviousTurns();
  app.interactionView?.reset();
  app.setBusy(true);
  app.taskIdText.textContent = entry.objective;
  app.taskIdText.title = `任务 ID：${entry.taskId}`;
  app.errorActions.hidden = true;
  app.replaying = false;
  app.streamView.reset();
  app.streamView.setLoading("正在载入记录…");
  app.showConversation(entry.objective);
  app.setStatus(entry.status);
  app.renderHistory();

  return generation;
}

function resetTask(app: RendererApp): void {
  if (app.submitting) return;
  app.viewGeneration += 1;
  app.interactionView?.reset();
  if (app.activeTaskId) window.bitAgent.unwatchTask(app.activeTaskId);
  app.activeTaskId = null;
  app.stoppedTaskId = null;
  app.activeSessionId = null;
  setAgentMode("auto");
  app.dropProcesses();
  app.clearQueue();
  clearPreviousTurns();
  app.activeObjective = "";
  app.replaying = false;
  app.taskIdText.textContent = "新任务";
  app.taskIdText.removeAttribute("title");
  app.setStatus("IDLE");
  app.streamView.reset();
  app.emptyState.hidden = false;
  app.currentTurn.hidden = true;
  app.errorActions.hidden = true;
  app.objectiveInput.value = "";
  app.resetMetrics();
  app.setBusy(false);
  app.renderHistory();
  app.objectiveInput.focus();
}

export function createRunController(app: RendererApp) {
  return {
    prepareRun: prepareRun.bind(null, app),
    steer: steer.bind(null, app),
    runAgent: runAgent.bind(null, app),
    restoreTask: restoreTask.bind(null, app),
    resetTask: resetTask.bind(null, app),
  };
}

