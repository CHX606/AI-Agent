import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {} from "../src/renderer/global";
import type { RendererApp } from "../src/renderer/application/context";
import { createHistoryController } from "../src/renderer/application/history";
import { createRunController } from "../src/renderer/application/run";
import type { TaskHistoryEntry } from "../src/renderer/task-history";

vi.mock("../src/renderer/session-view", () => ({
  clearPreviousTurns: vi.fn(), getAgentMode: vi.fn(() => "auto"),
  renderPreviousTurns: vi.fn(), setAgentMode: vi.fn(),
}));
vi.mock("../src/renderer/product-controls", () => ({ permissionMode: vi.fn(() => "confirm") }));
vi.mock("../src/renderer/workspace-tree", async importOriginal => ({
  ...await importOriginal<typeof import("../src/renderer/workspace-tree")>(), renderWorkspaceTree: vi.fn(),
}));

const currentGateway = "http://127.0.0.1:54218";
const oldGateway = "http://127.0.0.1:43117";
const api = {
  getSession: vi.fn(), getTask: vi.fn(), watchTask: vi.fn(), unwatchTask: vi.fn(),
  renameSession: vi.fn(), deleteSession: vi.fn(),
};
const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };

class TestElement {
  value = "";
  textContent = "";
  title = "";
  hidden = false;
  className = "";
  maxLength = 0;
  replacement: TestElement | null = null;
  listeners = new Map<string, () => void>();
  focus = vi.fn();
  select = vi.fn();
  setAttribute = vi.fn();

  replaceWith(input: TestElement): void { this.replacement = input; }
  addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
  blur(): void { this.listeners.get("blur")?.(); }
}

function historyEntry(): TaskHistoryEntry {
  return {
    taskId: "task-from-previous-launch", sessionId: "saved-session", objective: "Saved conversation",
    workspaceRoot: "D:/test-workspace", gatewayUrl: oldGateway, status: "COMPLETED",
    createdAt: "2026-10-04T12:00:00.000Z",
  };
}

function fixture(entry: TaskHistoryEntry): RendererApp {
  const app = {
    gatewayUrl: currentGateway,
    activeTaskId: null as string | null, activeSessionId: null as string | null,
    activeObjective: "", activeWorkspaceRoot: entry.workspaceRoot,
    stoppedTaskId: null, stoppedTasks: new Set<string>(),
    submitting: false, viewGeneration: 0, replaying: false,
    history: [entry], searchResults: null, terminalStatuses: new Set(["COMPLETED"]),
    objectiveInput: new TestElement(), objectiveDisplay: new TestElement(),
    taskIdText: new TestElement(), errorActions: new TestElement(), connectionDot: new TestElement(),
    interactionView: { reset: vi.fn(), update: vi.fn() },
    streamView: {
      reset: vi.fn(), setLoading: vi.fn(), scrollToEnd: vi.fn(), setStartedAt: vi.fn(),
    },
    setWorkspace: vi.fn(), dropProcesses: vi.fn(), clearQueue: vi.fn(), setBusy: vi.fn(),
    showConversation: vi.fn(), setStatus: vi.fn(), renderHistory: vi.fn(), showError: vi.fn(),
    previousTurnOptions: vi.fn(() => ({})), resetTask: vi.fn(),
    requestInput: vi.fn(() => ({ gatewayUrl: app.gatewayUrl, taskId: app.activeTaskId })),
  };
  return app as unknown as RendererApp;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getSession.mockResolvedValue({ session: { multi_agent_mode: "auto" } });
  api.getTask.mockResolvedValue({ status: "COMPLETED", objective: "Saved task" });
  api.renameSession.mockResolvedValue({});
  api.deleteSession.mockResolvedValue({});
  vi.stubGlobal("window", { bitAgent: api, confirm: vi.fn(() => true) });
  vi.stubGlobal("document", { createElement: () => new TestElement() });
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => vi.unstubAllGlobals());

describe("internal gateway routing for saved conversations", () => {
  it.each(["COMPLETED", "RUNNING"])(
    "restores a %s task through the current gateway without adopting the saved port",
    async (status) => {
      const entry = historyEntry();
      const app = fixture(entry);
      api.getTask.mockResolvedValue({ status, objective: "Saved task" });

      await createRunController(app).restoreTask(entry);

      expect(api.getSession).toHaveBeenCalledWith({
        gatewayUrl: currentGateway, sessionId: entry.sessionId,
      });
      expect(api.getTask).toHaveBeenCalledWith({
        gatewayUrl: currentGateway, taskId: entry.taskId,
      });
      expect(api.watchTask).toHaveBeenCalledWith({
        gatewayUrl: currentGateway, taskId: entry.taskId,
      });
      expect(app.gatewayUrl).toBe(currentGateway);
      expect(app.showError).not.toHaveBeenCalled();
    },
  );

  it("keeps the current gateway when restoring the saved conversation fails", async () => {
    const entry = historyEntry();
    const app = fixture(entry);
    const failure = new Error("Saved session is unavailable");
    api.getSession.mockRejectedValueOnce(failure);

    await createRunController(app).restoreTask(entry);

    expect(api.getSession).toHaveBeenCalledWith({
      gatewayUrl: currentGateway, sessionId: entry.sessionId,
    });
    expect(api.getTask).not.toHaveBeenCalled();
    expect(api.watchTask).not.toHaveBeenCalled();
    expect(app.showError).toHaveBeenCalledWith(failure);
    expect(app.gatewayUrl).toBe(currentGateway);
  });

  it("renames a conversation through the current gateway even when its saved port is stale", async () => {
    const entry = historyEntry();
    const app = fixture(entry);
    const title = new TestElement();
    createHistoryController(app).startRename(entry, title as unknown as HTMLElement);
    const input = title.replacement!;
    input.value = "Renamed conversation";

    input.blur();
    await vi.waitFor(() => expect(app.history[0]?.objective).toBe("Renamed conversation"));

    expect(api.renameSession).toHaveBeenCalledWith({
      gatewayUrl: currentGateway, sessionId: entry.sessionId, title: "Renamed conversation",
    });
    expect(storage.setItem).toHaveBeenCalled();
    expect(app.gatewayUrl).toBe(currentGateway);
    expect(app.connectionDot.title).toBe("");
  });

  it("deletes a conversation through the current gateway even when its saved port is stale", async () => {
    const entry = historyEntry();
    const app = fixture(entry);

    await createHistoryController(app).deleteConversation(entry);

    expect(api.deleteSession).toHaveBeenCalledWith({
      gatewayUrl: currentGateway, sessionId: entry.sessionId,
    });
    expect(app.history).toEqual([]);
    expect(storage.setItem).toHaveBeenCalled();
    expect(app.gatewayUrl).toBe(currentGateway);
    expect(app.connectionDot.title).toBe("");
  });
  it("reports rename errors through the connection dot title", async () => {
    const entry = historyEntry();
    const app = fixture(entry);
    api.renameSession.mockRejectedValueOnce(new Error("Rename denied"));
    const title = new TestElement();
    createHistoryController(app).startRename(entry, title as unknown as HTMLElement);
    title.replacement!.value = "Changed";
    title.replacement!.blur();
    await vi.waitFor(() => expect(app.connectionDot.title).toBe("重命名失败：Rename denied"));
    expect(app.history[0]?.objective).toBe(entry.objective);
  });

  it("preserves the conversation when deletion fails and reports the error on the dot", async () => {
    const entry = historyEntry();
    const app = fixture(entry);
    api.deleteSession.mockRejectedValueOnce(new Error("Delete denied"));
    await createHistoryController(app).deleteConversation(entry);
    expect(app.connectionDot.title).toBe("删除失败：Delete denied");
    expect(app.history).toEqual([entry]);
  });

});

