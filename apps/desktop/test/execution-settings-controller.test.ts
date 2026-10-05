import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {} from "../src/renderer/global";
import { ExecutionSettingsController } from "../src/renderer/product/execution-controller";

class Control {
  value = "100";
  disabled = false;
  loading = false;
  hidden = true;
  textContent = "";
  open = false;
  dataset: Record<string, string> = {};
  handlers = new Map<string, (event: Event) => void>();
  setAttribute = vi.fn();
  addEventListener(type: string, handler: (event: Event) => void): void { this.handlers.set(type, handler); }
  dispatch(type: string): Event {
    const event = new Event(type, { cancelable: true });
    this.handlers.get(type)?.(event);
    return event;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const nodes = Object.fromEntries(["form", "wa-input", "#execution-settings-save", "#execution-settings-reset",
    "#execution-settings-feedback", "#execution-settings-cancel", "#execution-settings-close"]
    .map(selector => [selector, new Control()]));
  const dialog = Object.assign(new Control(), { querySelector: (selector: string) => nodes[selector] });
  const trigger = new Control();
  const controller = new ExecutionSettingsController(dialog as unknown as HTMLElementTagNameMap["wa-dialog"]);
  controller.bind(trigger as unknown as HTMLButtonElement);
  return { controller, dialog, trigger, nodes, input: nodes["wa-input"]!, save: nodes["#execution-settings-save"]!,
    feedback: nodes["#execution-settings-feedback"]!, form: nodes.form! };
}

const api = { getExecutionSettings: vi.fn(), saveExecutionSettings: vi.fn() };
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("window", { bitAgent: api }); });
afterEach(() => vi.unstubAllGlobals());

it("retains loading protection and ignores a read arriving after the dialog is closed", async () => {
  const pending = deferred<{ maxToolRounds: number }>();
  api.getExecutionSettings.mockReturnValue(pending.promise);
  const view = fixture();
  const opening = view.controller.open();
  expect(view.dialog.open).toBe(true);
  expect(view.save.disabled).toBe(true);
  view.nodes["#execution-settings-cancel"]!.dispatch("click");
  view.dialog.dispatch("wa-hide");
  pending.resolve({ maxToolRounds: 325 });
  await opening;
  expect(view.dialog.open).toBe(false);
  expect(view.input.value).toBe("100");
});

it("keeps the newest settings when an earlier open finishes late", async () => {
  const first = deferred<{ maxToolRounds: number }>();
  api.getExecutionSettings.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ maxToolRounds: 42 });
  const view = fixture();
  const earlier = view.controller.open();
  await view.controller.open();
  first.resolve({ maxToolRounds: 325 });
  await earlier;
  expect(view.input.value).toBe("42");
  expect(view.save.disabled).toBe(false);
});

it("saves once, blocks closing during save and restores controls after success", async () => {
  api.getExecutionSettings.mockResolvedValue({ maxToolRounds: 100 });
  const pending = deferred<{ maxToolRounds: number }>();
  api.saveExecutionSettings.mockReturnValue(pending.promise);
  const view = fixture();
  await view.controller.open();
  view.input.value = "325";
  const submitted = view.form.dispatch("submit");
  view.form.dispatch("submit");
  view.nodes["#execution-settings-cancel"]!.dispatch("click");
  expect(submitted.defaultPrevented).toBe(true);
  expect(view.dialog.open).toBe(true);
  expect(view.dialog.dispatch("wa-hide").defaultPrevented).toBe(true);
  expect(api.saveExecutionSettings).toHaveBeenCalledExactlyOnceWith({ maxToolRounds: 325 });
  expect(view.save.loading).toBe(true);
  pending.resolve({ maxToolRounds: 325 });
  await pending.promise;
  await Promise.resolve();
  expect(view.save.loading).toBe(false);
  expect(view.save.disabled).toBe(false);
  expect(view.feedback.dataset.kind).toBe("success");
  expect(view.feedback.textContent).toContain("325");
});

it("reports a failed save and permits retry without hiding the error", async () => {
  api.getExecutionSettings.mockResolvedValue({ maxToolRounds: 100 });
  const pending = deferred<{ maxToolRounds: number }>();
  api.saveExecutionSettings.mockReturnValue(pending.promise);
  const view = fixture();
  await view.controller.open();
  view.form.dispatch("submit");
  pending.reject(new Error("write denied"));
  await pending.promise.catch(() => undefined);
  await Promise.resolve();
  expect(view.feedback.hidden).toBe(false);
  expect(view.feedback.textContent).toBe("write denied");
  expect(view.feedback.dataset.kind).toBe("error");
  expect(view.save.disabled).toBe(false);
  expect(view.input.disabled).toBe(false);
});
