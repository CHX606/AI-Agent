import type { RendererApp } from "./context";

/** 界面立即停止，取消与保存仍由原有后台链路完成。 */
async function stopTask(app: RendererApp): Promise<void> {
  if (!app.activeTaskId || isLocallyStopped(app)) return;
  const input = app.requestInput();
  const generation = app.viewGeneration;
  app.stoppedTaskId = input.taskId;
  app.stoppedTasks.add(input.taskId);
  app.setStatus("CANCELLED");
  try {
    const task = await window.bitAgent.cancelTask(input);
    if (generation !== app.viewGeneration || input.taskId !== app.activeTaskId) return;
    app.applyInteractionTask(task);
  } catch (error) {
    app.stoppedTasks.delete(input.taskId);
    if (generation !== app.viewGeneration || input.taskId !== app.activeTaskId) return;
    app.stoppedTaskId = null;
    app.showError(error);
  }
}

export function createStopController(app: RendererApp) {
  return { stopTask: stopTask.bind(null, app) };
}


export function isLocallyStopped(app: RendererApp): boolean {
  return app.activeTaskId !== null && app.stoppedTasks.has(app.activeTaskId);
}
