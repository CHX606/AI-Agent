import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {} from "../src/renderer/global";
import type { RendererApp } from "../src/renderer/application/context";
import { createComposerController } from "../src/renderer/application/composer";

vi.mock("../src/renderer/session-view", () => ({ setModeDisabled: vi.fn() }));

function fixture() {
  const button = {
    dataset: { state: "send", empty: "true" },
    innerHTML: "",
    title: "",
    disabled: false,
    setAttribute: vi.fn(),
    querySelector: vi.fn(() => button.innerHTML.includes("<svg") ? {} : null),
  };
  const input = { value: "", focus: vi.fn() };
  const partial: Partial<RendererApp> = {
    activeTaskId: null, stoppedTaskId: null, stoppedTasks: new Set(), replaying: false, submitting: false,
    runButton: button as unknown as HTMLButtonElement,
    objectiveInput: input as unknown as HTMLTextAreaElement,
    statusText: { dataset: { status: "IDLE" } } as unknown as HTMLElement,
    supplementStatuses: new Set(["QUEUED", "RUNNING", "PAUSED", "PAUSE_REQUESTED"]),
    interactionView: null,
    RUN_ICONS: {
      send: '<svg data-icon="send"></svg>', running: '<svg data-icon="running"></svg>',
      paused: '<svg data-icon="paused"></svg>', stopped: '<svg data-icon="stopped"></svg>',
    },
    RUN_LABELS: { send: "发送（Enter）", running: "停止这一轮", paused: "继续执行",
      stopped: "已停止", stopping: "发送（Enter）", waiting: "等待回答" },
  };
  const app = partial as RendererApp;
  Object.assign(app, createComposerController(app));
  return { app, button, input };
}

beforeEach(() => vi.stubGlobal("document", { body: { dataset: { busy: "false" } } }));
afterEach(() => vi.unstubAllGlobals());

describe("composer primary button", () => {
  it("fills an empty icon even when HTML already declares the send state", () => {
    const { app, button } = fixture();
    app.paintRunButton();
    expect(button.innerHTML).toContain('data-icon="send"');
    expect(button.disabled).toBe(true);
    expect(button.dataset.empty).toBe("true");
    expect(button.setAttribute).toHaveBeenCalledWith("aria-label", "发送（Enter）");
  });

  it("enables sending only when the idle input contains non-whitespace text", () => {
    const { app, button, input } = fixture();
    input.value = "   ";
    app.paintRunButton();
    expect(button.disabled).toBe(true);
    input.value = "你好";
    app.paintRunButton();
    expect(button.disabled).toBe(false);
    expect(button.dataset.empty).toBe("false");
    expect(button.innerHTML).toContain('data-icon="send"');
    input.value = "";
    app.paintRunButton();
    expect(button.disabled).toBe(true);
  });

  it("keeps the running stop action usable with an empty composer", () => {
    const { app, button } = fixture();
    document.body.dataset.busy = "true";
    app.activeTaskId = "task-1";
    app.statusText.dataset.status = "RUNNING";
    app.paintRunButton();
    expect(button.dataset.state).toBe("running");
    expect(button.innerHTML).toContain('data-icon="running"');
    expect(button.disabled).toBe(false);
  });

  it("switches running text to an enabled send action and preserves the existing icon on repaint", () => {
    const { app, button, input } = fixture();
    document.body.dataset.busy = "true";
    app.activeTaskId = "task-1";
    app.statusText.dataset.status = "RUNNING";
    app.paintRunButton();
    input.value = "补充要求";
    app.paintRunButton();
    expect(button.dataset.state).toBe("send");
    expect(button.disabled).toBe(false);
    const markup = button.innerHTML;
    app.paintRunButton();
    expect(button.innerHTML).toBe(markup);
  });

  it("keeps paused continuation usable with empty input and protects a locally stopped task", () => {
    const { app, button } = fixture();
    document.body.dataset.busy = "true";
    app.activeTaskId = "task-1";
    app.statusText.dataset.status = "PAUSED";
    app.paintRunButton();
    expect(button.dataset.state).toBe("paused");
    expect(button.disabled).toBe(false);
    app.stoppedTasks.add("task-1");
    app.paintRunButton();
    expect(button.dataset.state).toBe("stopped");
    expect(button.disabled).toBe(true);
  });

  it("enables image-only messages while retaining stop and read-in-progress behavior", () => {
    const { app, button } = fixture();
    let reading = false;
    app.composerImages = { snapshot: () => [{ name: "screen.png" }], isReading: () => reading } as unknown as RendererApp["composerImages"];
    app.paintRunButton();
    expect(button.disabled).toBe(false);
    expect(button.dataset.empty).toBe("false");
    reading = true;
    app.paintRunButton();
    expect(button.disabled).toBe(true);
    app.composerImages = null;
    document.body.dataset.busy = "true";
    app.activeTaskId = "task-1";
    app.statusText.dataset.status = "RUNNING";
    app.paintRunButton();
    expect(button.disabled).toBe(false);
    expect(button.dataset.state).toBe("running");
  });
});
