import { isLocallyStopped } from "./stop";
import {
setModeDisabled
} from "../session-view";
import type { RendererApp,RunState } from "./context";
import { hasComposerContent } from "./message";

function requestInput(app: RendererApp) {
  if (!app.activeTaskId) throw new Error("当前没有任务");
  return { gatewayUrl: app.gatewayUrl, taskId: app.activeTaskId };
}

function setBusy(app: RendererApp, busy: boolean): void {
  const permission = document.querySelector<HTMLElement & { disabled: boolean }>("#permission-mode");
  if (permission) permission.disabled = busy;
  document.body.dataset.busy = String(busy);
  app.retryButton.disabled = busy;
  app.newTaskButton.disabled = app.submitting;
  app.cancelButton.disabled = !busy;
  app.cancelButton.hidden = true;
  app.workspaceInput.disabled = busy || Boolean(app.activeSessionId);
  app.objectiveInput.disabled = busy;
  app.browseButton.disabled = busy || Boolean(app.activeSessionId);
  setModeDisabled(busy);
  app.modelMenu?.setDisabled(busy);
  app.workspaceChooser?.setDisabled(busy);
  for (const button of app.taskHistory.querySelectorAll<HTMLButtonElement>("button")) {
    button.disabled = app.submitting;
  }
  app.paintComposer();
}

function composerMode(app: RendererApp): "new" | "supplement" | "answer" | "locked" {
  if (document.body.dataset.busy !== "true") return "new";
  const status = app.statusText.dataset.status ?? "";
  if (app.replaying || !app.activeTaskId) return "locked";
  if (status === "WAITING_FOR_INPUT" && app.interactionView?.pendingKind()) return "answer";
  return app.supplementStatuses.has(status) ? "supplement" : "locked";
}

function fitComposer(app: RendererApp): void {
  app.objectiveInput.style.height = "auto";
  const limit = Number.parseFloat(getComputedStyle(app.objectiveInput).maxHeight) || 220;
  app.objectiveInput.style.height = `${Math.min(app.objectiveInput.scrollHeight + 1, limit)}px`;
}

function runState(app: RendererApp): RunState {
  if (document.body.dataset.busy !== "true") return "send";
  if (isLocallyStopped(app)) return "stopped";
  const status = app.statusText.dataset.status ?? "";
  const mode = app.composerMode();
  if (hasComposerContent(app) && (mode === "supplement" || mode === "answer")) return "send";
  if (status === "PAUSE_REQUESTED" || status === "CANCELLATION_REQUESTED") return "stopped";
  if (status === "PAUSED") return "paused";
  if (status === "WAITING_FOR_INPUT") return "waiting";
  if (mode === "locked") return "stopping";
  return "running";
}

function paintRunButton(app: RendererApp): void {
  const state = app.runState();
  if (app.runButton.dataset.state !== state || !app.runButton.querySelector("svg")) {
    app.runButton.dataset.state = state;
    const icon = state === "stopping" || state === "waiting" ? "send" : state;
    app.runButton.innerHTML = app.RUN_ICONS[icon];
  }
  const empty = !hasComposerContent(app);
  app.runButton.dataset.empty = String(empty);
  app.runButton.title = app.RUN_LABELS[state];
  app.runButton.setAttribute("aria-label", app.RUN_LABELS[state]);
  app.runButton.disabled = app.submitting || (state === "send" && (empty || Boolean(app.composerImages?.isReading())))
    || ["stopped", "stopping", "waiting"].includes(state);
}

async function primaryAction(app: RendererApp): Promise<void> {
  const state = app.runState();
  if (state === "send") {
    if (document.body.dataset.busy !== "true" && !hasComposerContent(app)) {
      app.objectiveInput.focus();
      return;
    }
    await app.runAgent();
  } else if (state === "running") await app.stopTask();
  else if (state === "paused") await app.interactionView?.resume();
}

function paintComposer(app: RendererApp): void {
  app.fitComposer();
  const mode = app.composerMode();
  const status = app.statusText.dataset.status;
  document.body.dataset.steering = mode === "answer" ? "WAITING_FOR_INPUT" : mode === "supplement" ? status ?? "" : "";
  if (document.body.dataset.busy === "true") app.objectiveInput.disabled = mode === "locked" && !(app.stoppedTaskId && app.stoppedTaskId === app.activeTaskId);
  // 运行中写了文字：工具栏左侧换成“引导 / 排队”两个选择（多 Agent 和权限这时本来就不能改）。
  const choosing = mode === "supplement" && hasComposerContent(app);
  app.steerChoice.hidden = !choosing;
  app.composerContext.dataset.choosing = String(choosing);
  app.paintRunButton();
  app.composerImages?.refresh();
  const approval = app.interactionView?.pendingKind() === "approval";
  app.objectiveInput.placeholder = mode === "answer"
    ? approval ? "不批准？写下原因按 Enter，Agent 会按你的意见调整…" : "直接写下你的回答，按 Enter 提交…"
    : mode === "supplement"
      ? status === "PAUSED"
        ? "写下补充要求，按 Enter 提交并继续…"
        : "补充要求：Enter 立即引导正在运行的 Agent，Tab 排到这一轮结束后发送…"
      : app.defaultPlaceholder;
}

function cyclePermission(app: RendererApp): void {
  const select = document.querySelector<HTMLElement & { value: string; disabled: boolean }>("#permission-mode");
  if (!select || select.disabled) return;
  const index = app.permissionOrder.indexOf(select.value as typeof app.permissionOrder[number]);
  select.value = app.permissionOrder[(index + 1) % app.permissionOrder.length]!;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

export function createComposerController(app: RendererApp) {
  return {
    requestInput: requestInput.bind(null, app),
    setBusy: setBusy.bind(null, app),
    composerMode: composerMode.bind(null, app),
    fitComposer: fitComposer.bind(null, app),
    runState: runState.bind(null, app),
    paintRunButton: paintRunButton.bind(null, app),
    primaryAction: primaryAction.bind(null, app),
    paintComposer: paintComposer.bind(null, app),
    cyclePermission: cyclePermission.bind(null, app),
  };
}

