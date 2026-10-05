import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {} from "../src/renderer/global";
import type { RendererApp } from "../src/renderer/application/context";
import { createStopController } from "../src/renderer/application/stop";

const cancelTask = vi.fn();
const request = { gatewayUrl: "http://localhost:4317", taskId: "task-1" };

function deferred() {
  let resolve!: (task: Record<string, unknown>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Record<string, unknown>>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(): RendererApp {
  const app: Partial<RendererApp> = {
    activeTaskId: request.taskId,
    stoppedTaskId: null,
    stoppedTasks: new Set<string>(),
    viewGeneration: 1,
    requestInput: vi.fn(() => request),
    setStatus: vi.fn(),
    applyInteractionTask: vi.fn(),
    showError: vi.fn(),
  };
  return app as RendererApp;
}

beforeEach(() => {
  cancelTask.mockReset();
  vi.stubGlobal("window", { bitAgent: { cancelTask } });
});

afterEach(() => vi.unstubAllGlobals());

describe("stop task controller", () => {
  it("synchronously shows stopped before the cancellation request completes", async () => {
    const response = deferred();
    cancelTask.mockReturnValue(response.promise);
    const app = fixture();
    const controller = createStopController(app);
    const stopped = controller.stopTask();
    expect(app.stoppedTaskId).toBe(request.taskId);
    expect(app.stoppedTasks.has(request.taskId)).toBe(true);
    expect(app.setStatus).toHaveBeenCalledWith("CANCELLED");
    expect(app.applyInteractionTask).not.toHaveBeenCalled();
    expect(cancelTask).toHaveBeenCalledWith(request);
    expect(vi.mocked(app.setStatus).mock.invocationCallOrder[0])
      .toBeLessThan(cancelTask.mock.invocationCallOrder[0]!);
    const task = { task_id: request.taskId, status: "CANCELLATION_REQUESTED" };
    response.resolve(task);
    await stopped;
    expect(app.applyInteractionTask).toHaveBeenCalledWith(task);
    expect(app.stoppedTasks.has(request.taskId)).toBe(true);
  });

  it("does not apply a delayed cancellation response after switching conversations", async () => {
    const response = deferred();
    cancelTask.mockReturnValue(response.promise);
    const app = fixture();
    const stopped = createStopController(app).stopTask();
    app.activeTaskId = "task-2";
    app.viewGeneration += 1;
    app.stoppedTaskId = "task-2";
    app.stoppedTasks.add("task-2");
    response.resolve({ task_id: request.taskId, status: "CANCELLED" });
    await stopped;
    expect(app.applyInteractionTask).not.toHaveBeenCalled();
    expect(app.stoppedTaskId).toBe("task-2");
  });

  it("ignores a delayed response after switching away and back to the same task", async () => {
    const response = deferred();
    cancelTask.mockReturnValue(response.promise);
    const app = fixture();
    const stopped = createStopController(app).stopTask();
    app.viewGeneration += 2;
    response.resolve({ task_id: request.taskId, status: "CANCELLED" });
    await stopped;
    expect(app.applyInteractionTask).not.toHaveBeenCalled();
  });

  it("explicitly reports a cancellation failure and permits retrying", async () => {
    const failure = new Error("取消请求失败");
    cancelTask.mockRejectedValue(failure);
    const app = fixture();
    const controller = createStopController(app);
    await controller.stopTask();
    expect(app.showError).toHaveBeenCalledWith(failure);
    expect(app.stoppedTaskId).toBeNull();
    expect(app.stoppedTasks.has(request.taskId)).toBe(false);
    expect(app.applyInteractionTask).not.toHaveBeenCalled();
    cancelTask.mockResolvedValue({ task_id: request.taskId, status: "CANCELLED" });
    await controller.stopTask();
    expect(cancelTask).toHaveBeenCalledTimes(2);
    expect(app.stoppedTasks.has(request.taskId)).toBe(true);
  });

  it("does not show an old failure in a new conversation or clear its stopped marker", async () => {
    const response = deferred();
    cancelTask.mockReturnValue(response.promise);
    const app = fixture();
    const stopped = createStopController(app).stopTask();
    app.activeTaskId = "task-2";
    app.viewGeneration += 1;
    app.stoppedTaskId = "task-2";
    app.stoppedTasks.add("task-2");
    response.reject(new Error("旧取消请求失败"));
    await stopped;
    expect(app.showError).not.toHaveBeenCalled();
    expect(app.stoppedTasks.has(request.taskId)).toBe(false);
    expect(app.stoppedTasks.has("task-2")).toBe(true);
    expect(app.stoppedTaskId).toBe("task-2");
  });

  it("does not send duplicate cancellation requests while one is still pending", async () => {
    const response = deferred();
    cancelTask.mockReturnValue(response.promise);
    const app = fixture();
    const controller = createStopController(app);
    const stopped = controller.stopTask();
    await controller.stopTask();
    expect(cancelTask).toHaveBeenCalledTimes(1);
    expect(app.setStatus).toHaveBeenCalledTimes(1);
    response.resolve({ task_id: request.taskId, status: "CANCELLED" });
    await stopped;
  });

  it("does nothing when there is no active task", async () => {
    const app = fixture();
    app.activeTaskId = null;
    await createStopController(app).stopTask();
    expect(cancelTask).not.toHaveBeenCalled();
    expect(app.setStatus).not.toHaveBeenCalled();
  });
});
