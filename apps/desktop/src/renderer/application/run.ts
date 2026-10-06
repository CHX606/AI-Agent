import type { ImageAttachment } from "../../shared/image-input";
import { renderMessageImages } from "../attachments/message-images";
import { taskWorkspaceRoot } from "../workspace-options";
import type { RendererApp } from "./context";
import { clearComposerMessage, composerMessage, type ComposerMessage } from "./message";
import { resetTask, restoreTask } from "./run-restore";
import { submitRun } from "./run-submit";

function prepareRun(app: RendererApp, objective: string, title = objective): void {
  app.interactionView?.reset();
  app.stoppedTaskId = null;
  app.replaying = false;
  app.activeObjective = objective;
  app.taskIdText.textContent = title;
  app.taskIdText.removeAttribute("title");
  app.errorActions.hidden = true;
  app.streamView.reset();
  app.showConversation(objective);
  if (app.objectiveDisplay.parentElement) renderMessageImages(app.objectiveDisplay.parentElement, app.activeImages);
  app.resetMetrics();
  app.setBusy(true);
  app.setStatus("SUBMITTING");
}

async function steer(app: RendererApp, mode: "supplement" | "answer"): Promise<void> {
  const message = composerMessage(app);
  if ((!message.text && !message.images.length) || app.composerImages?.isReading() || !app.interactionView || app.submitting) return;
  const approval = app.interactionView.pendingKind() === "approval";
  app.submitting = true;
  app.paintComposer();
  try {
    const sent = mode === "answer" ? await app.interactionView.answer(message.text, message.images)
      : await app.interactionView.supplement(message.text, message.images);
    if (sent) {
      clearComposerMessage(app);
      app.updateActiveHistory({ activityAt: new Date().toISOString() });
      app.streamView.userNote(mode === "answer" && approval ? `不批准：${message.text}` : message.text, message.images);
    }
  } finally {
    app.submitting = false;
    app.paintComposer();
  }
}

async function runAgent(app: RendererApp, text?: string, images?: ImageAttachment[]): Promise<void> {
  const composer = app.composerMode();
  if (text === undefined && (composer === "supplement" || composer === "answer")) { await app.steer(composer); return; }
  if (app.submitting || document.body.dataset.busy === "true" || (text === undefined && app.composerImages?.isReading())) return;
  const message: ComposerMessage = text === undefined ? composerMessage(app) : { text: text.trim(), images: images ?? [] };
  let workspaceRoot: string;
  try {
    if (!message.text && !message.images.length) throw new Error("请填写任务描述或添加图片");
    workspaceRoot = taskWorkspaceRoot(app.workspaceInput.value, app.activeSessionId ? app.activeWorkspaceRoot : null);
  } catch (error) {
    app.showError(error);
    app.workspaceChooser?.focus();
    return;
  }
  app.activeObjective = message.text;
  if (text === undefined) app.objectiveInput.value = "";
  await submitRun(app, message, workspaceRoot, text === undefined);
}

export function createRunController(app: RendererApp) {
  return {
    prepareRun: prepareRun.bind(null, app), steer: steer.bind(null, app), runAgent: runAgent.bind(null, app),
    restoreTask: restoreTask.bind(null, app), resetTask: resetTask.bind(null, app),
  };
}

