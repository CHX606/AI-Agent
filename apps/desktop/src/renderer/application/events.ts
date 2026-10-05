import { isLocallyStopped } from "./stop";
import type { TaskEvent } from "../../shared/contracts";
import { errorText,object } from "../dom";
import type { RendererApp } from "./context";

function setStatus(app: RendererApp, status: string): void {
  const visible = !app.replaying && isLocallyStopped(app) ? "CANCELLED" : status;
  app.statusText.textContent = app.statusLabels[visible] ?? visible;
  app.statusText.dataset.status = visible;
  app.interactionView?.setStatus(visible);
  if (!app.replaying) app.streamView.setStatus(visible);
  app.paintComposer();
  app.updateActiveHistory({ status: visible });
}

function applyInteractionTask(app: RendererApp, task: Record<string, unknown>): void {
  if (task.task_id !== app.activeTaskId) return;
  app.interactionView?.update(task);
  const status = typeof task.status === "string" ? task.status : "UNKNOWN";
  app.setStatus(status);
  app.setBusy(!app.terminalStatuses.has(status));
  if (app.terminalStatuses.has(status) && !app.replaying) void app.loadResult();
}

async function refreshInteraction(app: RendererApp): Promise<void> {
  if (!app.activeTaskId) return;
  const input = app.requestInput();
  const generation = app.viewGeneration;
  const sequence = ++app.interactionRefreshSequence;
  try {
    const task = await window.bitAgent.getTask(input);
    if (generation === app.viewGeneration && input.taskId === app.activeTaskId && sequence === app.interactionRefreshSequence) {
      app.applyInteractionTask(task);
    }
  } catch (error) {
    if (generation === app.viewGeneration && input.taskId === app.activeTaskId) {
      app.connectionDot.title = `交互状态暂未同步：${errorText(error)}`;
    }
  }
}

function showError(app: RendererApp, error: unknown): void {
  app.replaying = false;
  app.currentTurn.hidden = false;
  app.emptyState.hidden = true;
  app.setStatus("ERROR");
  app.streamView.showError(errorText(error));
  app.errorActions.hidden = false;
  app.setBusy(false);
}

function appendEvent(app: RendererApp, event: TaskEvent): void {
  if (app.routeProcessEvent(event)) return;
  // 切换对话后，旧任务仍可在后台执行，但它的事件不能写进新对话。
  if (event.taskId && event.taskId !== app.activeTaskId) return;
  if (event.event_type === "desktop_stream_ended") {
    app.replaying = false;
    void app.loadResult();
    return;
  }

  if (event.event_type === "desktop_connection_state") { handleConnection(app, event); return; }
  const data = object(event.data);
  if (typeof data?.status === "string") app.setStatus(data.status);
  if (!app.replaying && ["TASK_PAUSE_REQUESTED", "TASK_PAUSED", "TASK_RESUMED", "TASK_INTENT_UPDATED",
    "USER_QUESTION", "USER_ANSWERED", "QUESTION_DEFAULTED"].includes(event.event_type)) {
    void app.refreshInteraction();
  }
  if (event.event_type === "desktop_error") { app.showError(data?.message ?? event.data); return; }
  if (!isLocallyStopped(app) || app.replaying) app.streamView.handle(event);
}

export function createEventsController(app: RendererApp) {
  return {
    setStatus: setStatus.bind(null, app),
    applyInteractionTask: applyInteractionTask.bind(null, app),
    refreshInteraction: refreshInteraction.bind(null, app),
    showError: showError.bind(null, app),
    appendEvent: appendEvent.bind(null, app),
  };
}

function handleConnection(app: RendererApp, event: TaskEvent): void {
  const state = object(event.data);
  const restartRequired = state?.restart_required === true;
  app.connectionDot.title = state?.connected ? "已连接" : restartRequired
    ? "本地执行服务已退出，请重新启动应用后查看已保存的任务记录。"
    : "连接中断，正在自动重连；任务状态暂未同步";
  app.connectionDot.dataset.connected = String(Boolean(state?.connected));
  if (restartRequired) {
    // 旧的状态请求不能覆盖已经确认的执行服务退出提示。
    app.viewGeneration += 1;
    app.statusText.textContent = "执行服务已退出";
    app.statusText.dataset.status = "ERROR";
    app.interactionView?.setStatus("ERROR");
    app.setBusy(true);
    app.cancelButton.disabled = true;
    app.errorActions.hidden = true;
  }
  if (state?.connected) void app.refreshInteraction();
}

