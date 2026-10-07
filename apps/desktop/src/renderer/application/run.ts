import type { FileAttachment } from "../../shared/attachment-input";
import { renderMessageAttachments } from "../attachments/message-attachments";
import type { ImageAttachment } from "../../shared/image-input";
import { renderMessageImages } from "../attachments/message-images";
import { taskWorkspaceRoot } from "../workspace-options";
import type { RendererApp } from "./context";
import { clearComposerMessage, composerMessage, messageHasContent, type ComposerMessage } from "./message";
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
  if (app.objectiveDisplay.parentElement) {
    renderMessageImages(app.objectiveDisplay.parentElement, app.activeImages);
    renderMessageAttachments(app.objectiveDisplay.parentElement, app.activeAttachments);
  }
  app.resetMetrics();
  app.setBusy(true);
  app.setStatus("SUBMITTING");
}

function sendSteer(app: RendererApp, mode: "supplement" | "answer", message: ComposerMessage): Promise<boolean> {
  const view = app.interactionView!;
  const send = mode === "answer" ? view.answer.bind(view) : view.supplement.bind(view);
  return message.attachments?.length ? send(message.text, message.images, message.attachments) : send(message.text, message.images);
}
async function steer(app: RendererApp, mode: "supplement" | "answer"): Promise<void> {
  const message = composerMessage(app);
  if (!messageHasContent(message) || app.composerImages?.isReading() || !app.interactionView || app.submitting) return;
  const approval = app.interactionView.pendingKind() === "approval";
  app.submitting = true;
  app.paintComposer();
  try {
    const sent = await sendSteer(app, mode, message);
    if (sent) {
      clearComposerMessage(app);
      app.updateActiveHistory({ activityAt: new Date().toISOString() });
      const note = mode === "answer" && approval ? `不批准：${message.text}` : message.text;
      if (message.attachments?.length) app.streamView.userNote(note, message.images, message.attachments);
      else app.streamView.userNote(note, message.images);
    }
  } finally {
    app.submitting = false;
    app.paintComposer();
  }
}

async function runAgent(app: RendererApp, text?: string, images?: ImageAttachment[], attachments?: FileAttachment[]): Promise<void> {
  const composer = app.composerMode();
  if (text === undefined && (composer === "supplement" || composer === "answer")) { await app.steer(composer); return; }
  if (app.submitting || document.body.dataset.busy === "true" || (text === undefined && app.composerImages?.isReading())) return;
  const message: ComposerMessage = text === undefined ? composerMessage(app) : { text: text.trim(), images: images ?? [], ...(attachments?.length ? { attachments } : {}) };
  let workspaceRoot: string;
  try {
    if (!messageHasContent(message)) throw new Error("请填写任务描述或添加附件");
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
