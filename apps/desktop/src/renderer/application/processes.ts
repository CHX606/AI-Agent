import type { TaskEvent } from "../../shared/contracts";
import { object } from "../dom";
import {
type PreviousTurnOptions
} from "../session-view";
import { createStreamView,type FileDiff } from "../stream-view";
import type { RendererApp } from "./context";

function diffLoader(app: RendererApp, taskId: () => string | null) {
  return async (callId: string): Promise<FileDiff[]> => {
    const id = taskId();
    if (!id) return [];
    const payload = await window.bitAgent.getChanges({ gatewayUrl: app.gatewayUrl, taskId: id });
    const change = (Array.isArray(payload.changes) ? payload.changes : [])
      .map(object).find((item) => item?.call_id === callId);
    return (Array.isArray(change?.files) ? change.files : []).map(object)
      .filter((file): file is Record<string, unknown> => typeof file?.path === "string" && typeof file.diff === "string")
      .map((file) => ({ path: String(file.path), diff: String(file.diff), truncated: file.truncated === true }));
  };
}

function keepProcess(app: RendererApp, taskId: string, nodes: Node[]): void {
  if (!nodes.length) return;
  app.processCache.delete(taskId);
  app.processCache.set(taskId, nodes);
  // 只留最近 20 轮，长对话不会无限占内存；更早的轮次仍可以点开回放。
  while (app.processCache.size > 20) app.processCache.delete(app.processCache.keys().next().value!);
}

function dropProcesses(app: RendererApp): void {
  app.processCache.clear();
  for (const [taskId, loader] of app.processLoaders) {
    window.bitAgent.unwatchTask(taskId);
    loader.view.dispose();
    loader.fail(new Error("已切换对话"));
  }
  app.processLoaders.clear();
}

function previousTurnOptions(app: RendererApp): PreviousTurnOptions {
  return {
    processes: app.processCache,
    expand: (taskId, stream, answer) => new Promise<void>((resolve, reject) => {
      // 先回放到一个新列表里，成功后再换上；失败时保留原来的回答。
      const replay = document.createElement("ol");
      replay.className = "stream";
      const view = createStreamView({
        stream: replay, scroller: app.conversationScroller, follow: false, loadDiff: app.diffLoader(() => taskId),
      });
      app.processLoaders.set(taskId, {
        view, answer, fail: reject,
        done: () => {
          stream.replaceChildren(...replay.childNodes);
          app.keepProcess(taskId, [...stream.childNodes]);
          resolve();
        },
      });
      window.bitAgent.watchTask({ gatewayUrl: app.gatewayUrl, taskId });
    }),
  };
}

function routeProcessEvent(app: RendererApp, event: TaskEvent): boolean {
  const loader = event.taskId ? app.processLoaders.get(event.taskId) : undefined;
  if (!loader || !event.taskId) return false;
  if (event.event_type === "desktop_stream_ended" || event.event_type === "desktop_error") {
    app.processLoaders.delete(event.taskId);
    window.bitAgent.unwatchTask(event.taskId);
    loader.view.dispose();
    if (event.event_type === "desktop_error") {
      loader.fail(new Error("回放失败"));
    } else {
      loader.view.finish({ answer: loader.answer || null, failure: null, cancelled: false });
      loader.done();
    }
  } else if (!event.event_type.startsWith("desktop_")) {
    loader.view.handle(event);
  }
  return true;
}

export function createProcessesController(app: RendererApp) {
  return {
    diffLoader: diffLoader.bind(null, app),
    keepProcess: keepProcess.bind(null, app),
    dropProcesses: dropProcesses.bind(null, app),
    previousTurnOptions: previousTurnOptions.bind(null, app),
    routeProcessEvent: routeProcessEvent.bind(null, app),
  };
}
