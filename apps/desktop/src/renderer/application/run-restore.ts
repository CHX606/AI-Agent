import { renderMessageAttachments, savedAttachments } from "../attachments/message-attachments";
import { object } from "../dom";
import { renderMessageImages, savedImages } from "../attachments/message-images";
import { clearPreviousTurns, renderPreviousTurns, setAgentMode } from "../session-view";
import type { TaskHistoryEntry } from "../task-history";
import type { RendererApp } from "./context";

export async function restoreTask(app: RendererApp, entry: TaskHistoryEntry): Promise<void> {
  if (app.submitting || entry.taskId === app.activeTaskId) return;
  const generation = prepareRestore(app, entry);
  let currentUpdates: unknown;
  try {
    const input = { gatewayUrl: app.gatewayUrl, taskId: entry.taskId };
    if (entry.sessionId) {
      const saved = await window.bitAgent.getSession({ gatewayUrl: app.gatewayUrl, sessionId: entry.sessionId });
      if (generation !== app.viewGeneration) return;
      currentUpdates = savedCurrentUpdates(saved, entry.taskId);
      app.rewindableTaskId = typeof saved.rewindable_task_id === "string" ? saved.rewindable_task_id : null;
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
    app.activeImages = savedImages(task.images);
    app.activeAttachments = savedAttachments(task.attachments);
    if (app.objectiveDisplay.parentElement) {
      renderMessageImages(app.objectiveDisplay.parentElement, task.images);
      renderMessageAttachments(app.objectiveDisplay.parentElement, task.attachments);
    }
    appendSavedUploadUpdates(app, currentUpdates ?? task.intent_updates);
    watchRestoredTask(app, task, entry.status);
  } catch (error) {
    if (generation !== app.viewGeneration) return;
    app.showError(error);
  }
}

function savedCurrentUpdates(saved: Record<string, unknown>, taskId: string): unknown {
  if (!Array.isArray(saved.turns)) return undefined;
  const current = saved.turns.map(object).find(turn => turn?.task_id === taskId);
  return current?.intent_updates;
}

function appendSavedUploadUpdates(app: RendererApp, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const raw of value) {
    const update = object(raw);
    if (!update) continue;
    const images = Array.isArray(update.images) ? update.images : [];
    const attachments = Array.isArray(update.attachments) ? update.attachments : [];
    if (!images.length && !attachments.length) continue;
    const text = typeof update.text === "string" ? update.text : "";
    if (attachments.length) app.streamView.userNote(text, images, attachments);
    else app.streamView.userNote(text, images);
  }
}

function watchRestoredTask(app: RendererApp, task: Record<string, unknown>, fallbackStatus: string): void {
  app.interactionView?.update(task);
  const status = typeof task.status === "string" ? task.status : fallbackStatus;
  app.streamView.setStartedAt(typeof task.started_at === "string" ? task.started_at : null);
  if (app.terminalStatuses.has(status)) app.replaying = true;
  else { app.streamView.setLoading(null); app.setBusy(true); }
  app.setStatus(status);
  window.bitAgent.watchTask(app.requestInput());
}

function prepareRestore(app: RendererApp, entry: TaskHistoryEntry): number {
  if (app.activeTaskId) window.bitAgent.unwatchTask(app.activeTaskId);
  const generation = ++app.viewGeneration;
  app.activeSessionId = null;
  app.setWorkspace(entry.workspaceRoot);
  app.activeTaskId = entry.taskId;
  app.stoppedTaskId = app.stoppedTasks.has(entry.taskId) ? entry.taskId : null;
  app.activeSessionId = entry.sessionId ?? null;
  app.rewindableTaskId = null;
  app.activeObjective = entry.objective;
  app.activeImages = [];
  app.activeAttachments = [];
  app.objectiveInput.value = "";
  app.composerImages?.clear();
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

export function resetTask(app: RendererApp): void {
  if (app.submitting) return;
  app.viewGeneration += 1;
  app.interactionView?.reset();
  if (app.activeTaskId) window.bitAgent.unwatchTask(app.activeTaskId);
  app.activeTaskId = null;
  app.stoppedTaskId = null;
  app.activeSessionId = null;
  app.rewindableTaskId = null;
  setAgentMode("auto");
  app.dropProcesses();
  app.clearQueue();
  clearPreviousTurns();
  app.activeObjective = "";
  app.activeImages = [];
  app.activeAttachments = [];
  app.replaying = false;
  app.taskIdText.textContent = "新任务";
  app.taskIdText.removeAttribute("title");
  app.setStatus("IDLE");
  app.streamView.reset();
  app.emptyState.hidden = false;
  app.currentTurn.hidden = true;
  app.errorActions.hidden = true;
  app.objectiveInput.value = "";
  app.composerImages?.clear();
  app.resetMetrics();
  app.setBusy(false);
  app.renderHistory();
  app.objectiveInput.focus();
}
