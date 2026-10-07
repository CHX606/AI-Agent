import type { FileAttachment } from "../src/shared/attachment-input";
import { renderMessageAttachments } from "../src/renderer/attachments/message-attachments";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {} from "../src/renderer/global";
import type { ImageAttachment } from "../src/shared/image-input";
import type { RendererApp } from "../src/renderer/application/context";
import { createRunController } from "../src/renderer/application/run";
import { createQueueController } from "../src/renderer/application/queue";
import { renderMessageImages } from "../src/renderer/attachments/message-images";

vi.mock("../src/renderer/session-view", () => ({ clearPreviousTurns: vi.fn(), getAgentMode: vi.fn(() => "auto"),
  renderPreviousTurns: vi.fn(), setAgentMode: vi.fn() }));
vi.mock("../src/renderer/product-controls", () => ({ permissionMode: vi.fn(() => "confirm") }));
vi.mock("../src/renderer/attachments/message-images", async original => ({
  ...await original<typeof import("../src/renderer/attachments/message-images")>(), renderMessageImages: vi.fn(),
}));

vi.mock("../src/renderer/attachments/message-attachments", async original => ({
  ...await original<typeof import("../src/renderer/attachments/message-attachments")>(), renderMessageAttachments: vi.fn(),
}));

const file: FileAttachment = { name: "notes.txt", mime_type: "text/plain", data_url: "data:text/plain;base64,aGVsbG8=" };
const image: ImageAttachment = { name: "screen.png", mime_type: "image/png",
  data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2FIAAAAASUVORK5CYII=" };
const api = { createTask: vi.fn(), getSession: vi.fn(), getTask: vi.fn(), watchTask: vi.fn(), unwatchTask: vi.fn() };

class TestElement {
  value = ""; textContent = ""; title = ""; className = ""; hidden = false;
  children: TestElement[] = []; dataset: Record<string, string> = {};
  parentElement = {} as HTMLElement;
  focus = vi.fn(); setAttribute = vi.fn(); removeAttribute = vi.fn(); addEventListener = vi.fn();
  append(...elements: TestElement[]): void { this.children.push(...elements); }
  replaceChildren(...elements: TestElement[]): void { this.children = elements; }
}

function fixture(images = [image], text = "", attachments: FileAttachment[] = []) {
  let draft = images.map(value => ({ ...value }));
  let draftFiles = attachments.map(value => ({ ...value }));
  const composerImages = { snapshot: vi.fn(() => draft.map(value => ({ ...value }))),
    attachmentsSnapshot: vi.fn(() => draftFiles.map(value => ({ ...value }))),
    isReading: vi.fn(() => false), clear: vi.fn(() => { draft = []; draftFiles = []; }),
    set: vi.fn((value: ImageAttachment[], files: FileAttachment[] = []) => {
      draft = value.map(item => ({ ...item })); draftFiles = files.map(item => ({ ...item }));
    }), refresh: vi.fn() };
  const app = {
    gatewayUrl: "http://127.0.0.1:4000", activeTaskId: null, activeSessionId: null,
    activeWorkspaceRoot: "D:/repo", activeObjective: "", activeImages: [], activeAttachments: [],
    submitting: false, viewGeneration: 0, replaying: false, stoppedTaskId: null, stoppedTasks: new Set(),
    history: [], queued: [], queuedList: new TestElement(), terminalStatuses: new Set(["COMPLETED"]),
    workspaceInput: { value: "D:/repo" }, objectiveInput: Object.assign(new TestElement(), { value: text }),
    objectiveDisplay: new TestElement(), taskIdText: new TestElement(), errorActions: new TestElement(),
    emptyState: new TestElement(), currentTurn: new TestElement(), composerImages,
    composerMode: vi.fn(() => "new"), paintComposer: vi.fn(), resetMetrics: vi.fn(),
    setBusy: vi.fn((busy: boolean) => { document.body.dataset.busy = String(busy); }),
    setStatus: vi.fn(), renderHistory: vi.fn(), setWorkspace: vi.fn(), showConversation: vi.fn(),
    showError: vi.fn(() => { document.body.dataset.busy = "false"; }),
    upsertHistory: vi.fn(), updateActiveHistory: vi.fn(), dropProcesses: vi.fn(), keepProcess: vi.fn(),
    previousTurnOptions: vi.fn(() => ({})), workspaceChooser: { focus: vi.fn() },
    interactionView: { reset: vi.fn(), update: vi.fn(), pendingKind: vi.fn(() => "question"),
      supplement: vi.fn(async () => true), answer: vi.fn(async () => true) },
    streamView: { reset: vi.fn(), detach: vi.fn(() => []), setFirstTurn: vi.fn(), scrollToEnd: vi.fn(),
      setLoading: vi.fn(), setStartedAt: vi.fn(), userNote: vi.fn() },
  } as unknown as RendererApp;
  app.requestInput = () => ({ gatewayUrl: app.gatewayUrl, taskId: app.activeTaskId! });
  Object.assign(app, createRunController(app), createQueueController(app));
  return { app, composerImages };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { bitAgent: api });
  vi.stubGlobal("document", { body: { dataset: { busy: "false" } }, createElement: () => new TestElement() });
  api.createTask.mockResolvedValue({ task_id: "task-1", session_id: "session-1", status: "QUEUED" });
  api.getSession.mockResolvedValue({ turns: [] });
  api.getTask.mockResolvedValue({ task_id: "saved-task", objective: "", images: [image], status: "COMPLETED",
    intent_updates: [{ text: "", images: [image] }] });
});
afterEach(() => vi.unstubAllGlobals());

describe("image messages across the existing task flow", () => {
  it("submits an image-only new task and clears the draft only after acceptance", async () => {
    const { app, composerImages } = fixture();
    await app.runAgent();
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ objective: "", images: [image], workspaceRoot: "D:/repo" }));
    expect(composerImages.clear).toHaveBeenCalledOnce();
    expect(app.activeImages).toEqual([image]);
    expect(app.upsertHistory).toHaveBeenCalledWith(expect.objectContaining({ objective: "screen.png" }));
    expect(renderMessageImages).toHaveBeenCalledWith(app.objectiveDisplay.parentElement, [image]);
  });

  it("keeps the existing pure-text request free of an images key", async () => {
    const { app } = fixture([], "hello");
    await app.runAgent();
    expect(api.createTask.mock.calls[0]?.[0]).not.toHaveProperty("images");
    expect(api.createTask.mock.calls[0]?.[0].objective).toBe("hello");
  });

  it("continues the existing session with images and retains its conversation title", async () => {
    const { app } = fixture([image], "compare this");
    app.activeTaskId = "old-task";
    app.activeSessionId = "old-session";
    app.history = [{ taskId: "old-task", sessionId: "old-session", gatewayUrl: app.gatewayUrl,
      workspaceRoot: "D:/repo", objective: "Existing title", createdAt: "2026-10-05", status: "COMPLETED" }];
    await app.runAgent();
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "old-session", images: [image] }));
    expect(app.keepProcess).toHaveBeenCalledWith("old-task", []);
    expect(app.upsertHistory).toHaveBeenCalledWith(expect.objectContaining({ objective: "Existing title" }));
  });

  it("restores text and images on creation failure without discarding the draft", async () => {
    const { app, composerImages } = fixture([image], "look at this");
    api.createTask.mockRejectedValue(new Error("unavailable"));
    await app.runAgent();
    expect(app.objectiveInput.value).toBe("look at this");
    expect(composerImages.snapshot()).toEqual([image]);
    expect(app.submitting).toBe(false);
    expect(app.showError).toHaveBeenCalledWith(expect.objectContaining({ message: "unavailable" }));
  });

  it("sends an image-only live supplement and paints its exact local snapshot", async () => {
    const { app, composerImages } = fixture();
    app.composerMode = () => "supplement";
    document.body.dataset.busy = "true";
    await app.runAgent();
    expect(app.interactionView?.supplement).toHaveBeenCalledWith("", [image]);
    expect(app.streamView.userNote).toHaveBeenCalledWith("", [image]);
    expect(composerImages.snapshot()).toEqual([]);
  });

  it("keeps a failed supplement draft and retains approval rejection semantics with images", async () => {
    const { app, composerImages } = fixture([image], "change it");
    vi.mocked(app.interactionView!.supplement).mockResolvedValue(false);
    await app.steer("supplement");
    expect(composerImages.snapshot()).toEqual([image]);
    expect(app.objectiveInput.value).toBe("change it");
    app.interactionView!.pendingKind = () => "approval";
    await app.steer("answer");
    expect(app.interactionView?.answer).toHaveBeenCalledWith("change it", [image]);
    expect(app.streamView.userNote).toHaveBeenCalledWith("不批准：change it", [image]);
  });

  it("does not send or queue a partly read image batch", async () => {
    const { app, composerImages } = fixture([image], "text");
    composerImages.isReading.mockReturnValue(true);
    await app.runAgent();
    app.enqueue();
    expect(api.createTask).not.toHaveBeenCalled();
    expect(app.queued).toEqual([]);
    expect(composerImages.snapshot()).toEqual([image]);
  });

  it("keeps queued images independent from later composer edits and does not send after cancellation", () => {
    const { app, composerImages } = fixture();
    app.enqueue();
    composerImages.set([{ ...image, name: "later.png" }]);
    app.runAgent = vi.fn(async () => {});
    app.sendQueued("CANCELLED");
    expect(app.runAgent).not.toHaveBeenCalled();
    app.sendQueued("COMPLETED");
    expect(app.runAgent).toHaveBeenCalledWith("", [image]);
    expect(composerImages.snapshot()[0]?.name).toBe("later.png");
  });

  it("puts a failed queued message back without overwriting a later text-and-image draft", async () => {
    const { app, composerImages } = fixture([image], "queued A");
    app.enqueue();
    const later = { ...image, name: "later.png" };
    composerImages.set([later]);
    app.objectiveInput.value = "draft B";
    api.createTask.mockRejectedValueOnce(new Error("unavailable"));
    const run = vi.spyOn(app, "runAgent");
    app.sendQueued("COMPLETED");
    await run.mock.results[0]?.value;
    expect(app.queued).toEqual([{ text: "queued A", images: [image] }]);
    expect(app.objectiveInput.value).toBe("draft B");
    expect(composerImages.snapshot()).toEqual([later]);
    expect(api.createTask).toHaveBeenCalledOnce();
  });

  it("restores initial and follow-up images from a saved current turn even with empty text", async () => {
    const { app, composerImages } = fixture();
    await app.restoreTask({ taskId: "saved-task", sessionId: "saved-session", objective: "图片",
      gatewayUrl: app.gatewayUrl, workspaceRoot: "D:/repo", createdAt: "2026-10-05", status: "COMPLETED" });
    expect(app.activeImages).toEqual([image]);
    expect(app.activeObjective).toBe("");
    expect(renderMessageImages).toHaveBeenCalledWith(app.objectiveDisplay.parentElement, [image]);
    expect(app.streamView.userNote).toHaveBeenCalledWith("", [image]);
    expect(composerImages.snapshot()).toEqual([]);
  });

  it("restores image-only question answers from the complete current session turn", async () => {
    const { app } = fixture();
    const answerImage = { ...image, name: "answer.png" };
    api.getSession.mockResolvedValue({ turns: [{ task_id: "saved-task", intent_updates: [
      { text: "", images: [answerImage], question_id: "question-1" },
    ] }] });
    await app.restoreTask({ taskId: "saved-task", sessionId: "saved-session", objective: "图片",
      gatewayUrl: app.gatewayUrl, workspaceRoot: "D:/repo", createdAt: "2026-10-05", status: "COMPLETED" });
    expect(app.streamView.userNote).toHaveBeenCalledOnce();
    expect(app.streamView.userNote).toHaveBeenCalledWith("", [answerImage]);
  });
});

describe("ordinary attachments across the existing task flow", () => {
  it("submits a file-only task, uses its filename as the title and clears only the accepted draft", async () => {
    const { app, composerImages } = fixture([], "", [file]);
    await app.runAgent();
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ objective: "", attachments: [file] }));
    expect(api.createTask.mock.calls[0]?.[0]).not.toHaveProperty("images");
    expect(app.activeAttachments).toEqual([file]);
    expect(composerImages.attachmentsSnapshot()).toEqual([]);
    expect(app.upsertHistory).toHaveBeenCalledWith(expect.objectContaining({ objective: file.name }));
    expect(renderMessageAttachments).toHaveBeenCalledWith(app.objectiveDisplay.parentElement, [file]);
  });

  it("keeps mixed image/file channels separate when continuing a conversation", async () => {
    const { app } = fixture([image], "compare", [file]);
    app.activeSessionId = "old-session";
    await app.runAgent();
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "old-session", images: [image], attachments: [file] }));
  });

  it("restores text, images and files together after a rejected creation", async () => {
    const { app, composerImages } = fixture([image], "read these", [file]);
    api.createTask.mockRejectedValueOnce(new Error("unavailable"));
    await app.runAgent();
    expect(app.objectiveInput.value).toBe("read these");
    expect(composerImages.snapshot()).toEqual([image]);
    expect(composerImages.attachmentsSnapshot()).toEqual([file]);
  });

  it.each(["supplement", "answer"] as const)("sends a file-only %s and preserves a failed draft", async mode => {
    const { app, composerImages } = fixture([], "", [file]);
    app.composerMode = () => mode;
    vi.mocked(app.interactionView![mode]).mockResolvedValueOnce(false);
    await app.steer(mode);
    expect(composerImages.attachmentsSnapshot()).toEqual([file]);
    await app.steer(mode);
    expect(app.interactionView![mode]).toHaveBeenCalledWith("", [], [file]);
    expect(app.streamView.userNote).toHaveBeenCalledWith("", [], [file]);
    expect(composerImages.attachmentsSnapshot()).toEqual([]);
  });

  it("queues a file snapshot independently of later edits and restores a rejected queue item", async () => {
    const { app, composerImages } = fixture([], "queued A", [file]);
    app.enqueue();
    const later = { ...file, name: "later.txt" };
    composerImages.set([], [later]);
    app.objectiveInput.value = "draft B";
    api.createTask.mockRejectedValueOnce(new Error("unavailable"));
    const run = vi.spyOn(app, "runAgent");
    app.sendQueued("COMPLETED");
    await run.mock.results[0]?.value;
    expect(run).toHaveBeenCalledWith("queued A", [], [file]);
    expect(app.queued).toEqual([{ text: "queued A", images: [], attachments: [file] }]);
    expect(app.objectiveInput.value).toBe("draft B");
    expect(composerImages.attachmentsSnapshot()).toEqual([later]);
  });

  it("restores file-only initial messages and question answers from saved session turns", async () => {
    const { app } = fixture([], "", [file]);
    api.getTask.mockResolvedValue({ task_id: "saved-task", objective: "", attachments: [file], status: "COMPLETED" });
    api.getSession.mockResolvedValue({ turns: [{ task_id: "saved-task", intent_updates: [{ text: "", attachments: [file], question_id: "q1" }] }] });
    await app.restoreTask({ taskId: "saved-task", sessionId: "saved-session", objective: file.name,
      gatewayUrl: app.gatewayUrl, workspaceRoot: "D:/repo", createdAt: "2026-10-06", status: "COMPLETED" });
    expect(app.activeAttachments).toEqual([file]);
    expect(renderMessageAttachments).toHaveBeenCalledWith(app.objectiveDisplay.parentElement, [file]);
    expect(app.streamView.userNote).toHaveBeenCalledWith("", [], [file]);
  });

  it("blocks file-only submission and queueing until reading completes", async () => {
    const { app, composerImages } = fixture([], "", [file]);
    composerImages.isReading.mockReturnValue(true);
    await app.runAgent();
    app.enqueue();
    expect(api.createTask).not.toHaveBeenCalled();
    expect(app.queued).toEqual([]);
    expect(composerImages.attachmentsSnapshot()).toEqual([file]);
  });
});
