import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountProductControls } from "../src/renderer/product-controls";

const mocks = vi.hoisted(() => ({ model: vi.fn(), diagnostics: vi.fn(), memory: vi.fn(), tools: vi.fn(), execution: vi.fn(), terminal: vi.fn() }));
vi.mock("../src/renderer/product/terminal-settings", () => ({ showTerminalSettings: mocks.terminal }));
vi.mock("../src/renderer/product/model", () => ({ showModelSettings: mocks.model }));
vi.mock("../src/renderer/product/diagnostics", () => ({ showDiagnostics: mocks.diagnostics }));
vi.mock("../src/renderer/product/memory", () => ({ showMemories: mocks.memory }));
vi.mock("../src/renderer/mcp-panel", () => ({ renderMcpPanel: mocks.tools }));
vi.mock("../src/renderer/product/dialog", () => ({ ProductDialog: class {
  open = () => ({}); feedback = vi.fn();
} }));
vi.mock("../src/renderer/product/permission", () => ({ mountPermissionControl: vi.fn(), permissionMode: () => "confirm" }));
vi.mock("../src/renderer/product/review", () => ({ mountReviewButton: vi.fn() }));
vi.mock("../src/renderer/product/execution-dialog", () => ({ createExecutionDialog: vi.fn() }));
vi.mock("../src/renderer/product/execution-controller", () => ({ ExecutionSettingsController: class {
  bind(button: Button): void { button.addEventListener("click", mocks.execution); }
} }));
vi.mock("@awesome.me/webawesome/dist/components/dialog/dialog.js", () => ({}));
vi.mock("@awesome.me/webawesome/dist/components/input/input.js", () => ({}));
vi.mock("@awesome.me/webawesome/dist/components/button/button.js", () => ({}));
vi.mock("@awesome.me/webawesome/dist/translations/zh-cn.js", () => ({}));

class Button {
  id = "";
  type = "";
  className = "";
  innerHTML = "";
  title = "";
  parent: Button[] | undefined;
  onclick: (() => void) | undefined;
  handlers = new Map<string, () => void>();
  before(button: Button): void { this.insert(button, 0); }
  after(button: Button): void { this.insert(button, 1); }
  private insert(button: Button, offset: number): void {
    if (!this.parent) throw new Error("Button must be attached");
    button.parent = this.parent;
    this.parent.splice(this.parent.indexOf(this) + offset, 0, button);
  }
  addEventListener(type: string, handler: () => void): void { this.handlers.set(type, handler); }
  click(): void { this.handlers.get("click")?.(); this.onclick?.(); }
}

let profile: Button[];
let rail: Button[];
let queries: string[];
let created: Button[];
const diagnosticCurrent = () => ({ gatewayUrl: "http://localhost:3000", taskId: "task-1" });
const memoryCurrent = () => ({ gatewayUrl: "http://localhost:3000", workspaceRoot: "D:/work" });

beforeEach(() => {
  vi.clearAllMocks();
  const anchor = new Button(); anchor.id = "settings-panel";
  const theme = new Button(); theme.id = "theme-toggle";
  profile = [anchor]; anchor.parent = profile;
  rail = [theme]; theme.parent = rail;
  queries = []; created = [];
  vi.stubGlobal("document", {
    createElement: () => { const button = new Button(); created.push(button); return button; },
    querySelector: (selector: string) => {
      queries.push(selector);
      return [...profile, ...rail].find(item => '#' + item.id === selector) ?? null;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("creates all existing personal center settings without adding any rail shortcut", () => {
  mountProductControls(() => ({ gatewayUrl: "http://localhost:3000", taskId: "task-1" }), diagnosticCurrent, memoryCurrent);
  expect(profile.map(button => button.id)).toEqual([
    "model-settings", "execution-settings", "diagnostics-settings", "memory-settings", "mcp-settings", "terminal-settings", "settings-panel",
  ]);
  expect(rail.map(button => button.id)).toEqual(["theme-toggle"]);
  expect(queries).not.toContain("#theme-toggle");
  expect(created).toHaveLength(6);
  expect(created.every(button => button.className === "sidebar-model-settings")).toBe(true);
});

it("keeps each personal center action bound to its original settings feature", async () => {
  mountProductControls(() => ({ gatewayUrl: "http://localhost:3000", taskId: "task-1" }), diagnosticCurrent, memoryCurrent);
  for (const button of profile.filter(item => item.id !== "settings-panel")) button.click();
  await Promise.resolve();
  expect(mocks.model).toHaveBeenCalledTimes(1);
  expect(mocks.diagnostics).toHaveBeenCalledWith(expect.anything(), diagnosticCurrent);
  expect(mocks.memory).toHaveBeenCalledWith(expect.anything(), memoryCurrent);
  expect(mocks.tools).toHaveBeenCalledTimes(1);
  expect(mocks.execution).toHaveBeenCalledTimes(1);
  expect(mocks.terminal).toHaveBeenCalledWith(expect.anything());
});
