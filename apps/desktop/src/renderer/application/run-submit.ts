import { permissionMode } from "../product-controls";
import { getAgentMode, renderPreviousTurns } from "../session-view";
import type { RendererApp } from "./context";
import { clearComposerMessage, messageTitle, restoreComposerMessage, type ComposerMessage } from "./message";

function prepareSubmission(app: RendererApp, message: ComposerMessage) {
  const previousSession = app.activeSessionId;
  const mode = getAgentMode();
  if (app.activeTaskId) window.bitAgent.unwatchTask(app.activeTaskId);
  if (previousSession && app.activeTaskId) app.keepProcess(app.activeTaskId, app.streamView.detach());
  app.activeTaskId = null;
  const generation = ++app.viewGeneration;
  app.submitting = true;
  app.activeImages = message.images;
  const title = previousSession
    ? app.history.find(item => item.sessionId === previousSession && item.gatewayUrl === app.gatewayUrl)?.objective
    : undefined;
  app.prepareRun(message.text, title ?? messageTitle(message));
  app.streamView.setFirstTurn(!previousSession);
  return { previousSession, mode, generation };
}

export async function submitRun(app: RendererApp, message: ComposerMessage, workspaceRoot: string,
  fromComposer: boolean): Promise<void> {
  const context = prepareSubmission(app, message);
  try {
    if (context.previousSession) {
      const saved = await window.bitAgent.getSession({ gatewayUrl: app.gatewayUrl, sessionId: context.previousSession });
      renderPreviousTurns(saved, null, app.previousTurnOptions());
      app.streamView.scrollToEnd();
    }
    await createAndWatch(app, message, workspaceRoot, context);
    if (fromComposer && context.generation === app.viewGeneration) clearComposerMessage(app);
  } catch (error) {
    if (context.generation !== app.viewGeneration) return;
    app.showError(error);
    if (fromComposer) restoreComposerMessage(app, message);
    else { app.queued.unshift(message); app.renderQueue(); }
  } finally {
    app.submitting = false;
    app.setBusy(document.body.dataset.busy === "true");
  }
}

async function createAndWatch(app: RendererApp, message: ComposerMessage, workspaceRoot: string,
  context: ReturnType<typeof prepareSubmission>): Promise<void> {
  const task = await window.bitAgent.createTask({
    gatewayUrl: app.gatewayUrl, objective: message.text, workspaceRoot,
    ...(message.images.length ? { images: message.images } : {}),
    ...(context.previousSession ? { sessionId: context.previousSession } : {}),
    multiAgentMode: context.mode, permissionMode: permissionMode(), ...(app.modelMenu?.selection() ?? {}),
  });
  if (context.generation !== app.viewGeneration) return;
  if (typeof task.task_id !== "string") throw new Error("Gateway 没有返回 task_id");
  app.activeTaskId = task.task_id;
  app.activeSessionId = typeof task.session_id === "string" ? task.session_id : null;
  app.interactionView?.update(task);
  app.taskIdText.title = `任务 ID：${app.activeTaskId}`;
  const status = typeof task.status === "string" ? task.status : "QUEUED";
  const createdAt = typeof task.created_at === "string" ? task.created_at : new Date().toISOString();
  recordCreatedTask(app, message, workspaceRoot, context, status, createdAt);
  app.setStatus(status);
  window.bitAgent.watchTask(app.requestInput());
}

function recordCreatedTask(app: RendererApp, message: ComposerMessage, workspaceRoot: string,
  context: ReturnType<typeof prepareSubmission>, status: string, createdAt: string): void {
  app.activeWorkspaceRoot = workspaceRoot;
  const existing = context.previousSession
    ? app.history.find(item => item.sessionId === context.previousSession && item.gatewayUrl === app.gatewayUrl)
    : undefined;
  app.upsertHistory({
    taskId: app.requestInput().taskId, objective: existing?.objective ?? messageTitle(message), workspaceRoot,
    gatewayUrl: app.gatewayUrl, status, createdAt, activityAt: createdAt,
    ...(app.activeSessionId ? { sessionId: app.activeSessionId } : {}),
    multiAgentMode: context.mode, permissionMode: permissionMode(),
  });
}
