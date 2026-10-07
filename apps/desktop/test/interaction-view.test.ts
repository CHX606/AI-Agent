import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {} from "../src/renderer/global";
import { InteractionController } from "../src/renderer/interaction/controller";
import type { InteractionElements } from "../src/renderer/interaction/panel";

const mocks = vi.hoisted(() => ({ mount: vi.fn(), interact: vi.fn(), getTask: vi.fn() }));
vi.mock("../src/renderer/interaction/panel", () => ({ mountInteractionPanel: mocks.mount }));

class TestElement {
  hidden = true;
  disabled = false;
  open = false;
  value = "";
  textContent = "";
  dataset: Record<string, string> = {};
  children: TestElement[] = [];
  parent: TestElement | null = null;
  addEventListener = vi.fn();
  querySelector = vi.fn();
  querySelectorAll = vi.fn(() => []);
  focus = vi.fn();
  click = vi.fn();
  contains = vi.fn(() => false);
  replaceChildren(): void { this.children = []; }
  append(...children: TestElement[]): void {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }
  get lastElementChild(): TestElement | null { return this.children.at(-1) ?? null; }
}

let ui: ReturnType<typeof fixture>;
const apply = vi.fn();
const request = { gatewayUrl: "http://localhost:4317", taskId: "task-1" };
const question = {
  id: "q1", question: "采用哪个方案？", requires_confirmation: true,
  options: [{ id: "yes", label: "继续" }, { id: "no", label: "停止" }],
};

function fixture() {
  const elements = {
    cancel: new TestElement(), composer: new TestElement(), panel: new TestElement(),
    notice: new TestElement(), error: new TestElement(), questionBox: new TestElement(),
    questionTitle: new TestElement(), deadlineText: new TestElement(), operationDetails: new TestElement(),
    options: new TestElement(), answerButton: new TestElement(), intent: new TestElement(),
    applyButton: new TestElement(), endTask: new TestElement(),
    intentEditor: new TestElement(), panelBody: new TestElement(),
  };
  elements.operationDetails.querySelector.mockReturnValue(new TestElement());
  return elements;
}

beforeEach(() => {
  vi.clearAllMocks();
  ui = fixture();
  mocks.mount.mockReturnValue(ui as unknown as InteractionElements);
  vi.stubGlobal("document", {
    createElement: () => new TestElement(), addEventListener: vi.fn(), activeElement: {},
  });
  vi.stubGlobal("window", {
    setInterval: vi.fn(() => 1), clearInterval: vi.fn(), addEventListener: vi.fn(),
    bitAgent: { interactTask: mocks.interact, getTask: mocks.getTask },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("task interaction visibility", () => {
  it.each(["PAUSE_REQUESTED", "PAUSED", "CANCELLATION_REQUESTED", "CANCELLED"])(
    "clears the previous question and error when entering %s",
    (status) => {
      const view = new InteractionController({ current: () => request, apply });
      view.update({ task_id: request.taskId, status: "WAITING_FOR_INPUT", question });
      expect(ui.panel.hidden).toBe(false);
      expect(ui.options.children).toHaveLength(3);
      ui.error.hidden = false;
      ui.error.textContent = "旧错误";
      view.setStatus(status);
      expect(ui.panel.hidden).toBe(true);
      expect(ui.questionBox.hidden).toBe(true);
      expect(ui.questionTitle.textContent).toBe("");
      expect(ui.options.children).toHaveLength(0);
      expect(ui.error.hidden).toBe(true);
      expect(ui.error.textContent).toBe("");
      expect(view.pendingKind()).toBeNull();
    },
  );

  it("keeps stale questions hidden during backend cancellation and restores new approval prompts", () => {
    const view = new InteractionController({ current: () => request, apply });
    view.update({ task_id: request.taskId, status: "WAITING_FOR_INPUT", question });
    view.setStatus("CANCELLED");
    view.update({ task_id: request.taskId, status: "CANCELLATION_REQUESTED", question });
    expect(ui.panel.hidden).toBe(true);
    expect(ui.options.children).toHaveLength(0);
    view.update({ task_id: request.taskId, status: "WAITING_FOR_INPUT",
      question: { ...question, id: "q2", operation: { title: "修改 app.py" } } });
    expect(ui.panel.hidden).toBe(false);
    expect(ui.questionTitle.textContent).toBe("修改 app.py");
    expect(view.pendingKind()).toBe("approval");
  });

  it("discards an answer response that completes after the user stops", async () => {
    let finish!: (task: Record<string, unknown>) => void;
    mocks.interact.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = new InteractionController({ current: () => request, apply });
    view.update({ task_id: request.taskId, status: "WAITING_FOR_INPUT", question });
    const submitted = view.answer("继续");
    view.setStatus("CANCELLED");
    finish({ task_id: request.taskId, status: "RUNNING" });
    expect(await submitted).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(ui.panel.hidden).toBe(true);
  });

  it("does not surface delayed interaction errors after stopping", async () => {
    let fail!: (error: Error) => void;
    mocks.interact.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const view = new InteractionController({ current: () => request, apply });
    view.update({ task_id: request.taskId, status: "WAITING_FOR_INPUT", question });
    const submitted = view.answer("继续");
    view.setStatus("CANCELLED");
    fail(new Error("问题已经结束"));
    expect(await submitted).toBe(false);
    expect(ui.panel.hidden).toBe(true);
    expect(ui.error.hidden).toBe(true);
    expect(mocks.getTask).not.toHaveBeenCalled();
  });
});

it.each(["supplement", "answer"] as const)("preserves ordinary attachments through %s IPC calls", async mode => {
  const view = new InteractionController({ current: () => request, apply });
  view.update({ task_id: request.taskId, status: "WAITING_FOR_INPUT", question });
  mocks.interact.mockResolvedValue({ task_id: request.taskId, status: "RUNNING" });
  const file = { name: "notes.txt", mime_type: "text/plain", data_url: "data:text/plain;base64,aGVsbG8=" };
  expect(await view[mode]("", [], [file])).toBe(true);
  expect(mocks.interact).toHaveBeenCalledWith(expect.objectContaining({ action: mode, text: "", attachments: [file] }));
});
