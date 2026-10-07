import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RendererApp } from "../src/renderer/application/context";
import { mountTurnActions } from "../src/renderer/application/rewind";

const mocks = vi.hoisted(() => ({ buttons: new Map<string, { hidden: boolean; click: () => void }>(),
  rewind: vi.fn(), stream: { after: vi.fn() }, user: { hidden: false }, save: vi.fn() }));
vi.mock("../src/renderer/dom", async original => ({ ...await original<typeof import("../src/renderer/dom")>(), element: () => mocks.stream }));
vi.mock("../src/renderer/copy-button", () => ({ replyMarkdown: () => "answer" }));
vi.mock("../src/renderer/message-actions", () => ({
  iconButton: (label: string, _icon: string, click: () => void) => {
    const button = { hidden: false, click }; mocks.buttons.set(label, button); return button;
  }, userActions: () => mocks.user, replyActions: () => ({ hidden: false }),
}));
vi.mock("../src/renderer/task-history", () => ({ saveHistory: mocks.save }));

afterEach(() => vi.unstubAllGlobals());

const file = { name: "notes.txt", mime_type: "text/plain", data_url: "data:text/plain;base64,aGVsbG8=" };

function fixture(): RendererApp {
  return { gatewayUrl: "http://localhost:4000", activeTaskId: "task1", activeSessionId: "session1",
    activeWorkspaceRoot: "D:/repo", activeObjective: "", activeImages: [], activeAttachments: [file],
    rewindableTaskId: "task1", statusText: { dataset: { status: "COMPLETED" } },
    terminalStatuses: new Set(["COMPLETED"]), submitting: false, replaying: false, history: [],
    objectiveDisplay: { closest: () => ({ after: vi.fn() }) }, objectiveInput: { value: "", focus: vi.fn() },
    setBusy: vi.fn(), resetTask: vi.fn(), newConversationIn: vi.fn(),
    composerImages: { set: vi.fn() }, paintComposer: vi.fn(), runAgent: vi.fn(async () => {}),
  } as unknown as RendererApp;
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.buttons.clear();
  vi.stubGlobal("document", { body: { dataset: { busy: "false" } } });
  vi.stubGlobal("window", { confirm: () => true, alert: vi.fn(), bitAgent: { rewindTurn: mocks.rewind, unwatchTask: vi.fn() } });
  mocks.rewind.mockResolvedValue({ objective: "", images: [], attachments: [file], workspace_root: "D:/repo", session_deleted: true });
});

it("shows edit and regeneration actions for file-only messages and restores the original file draft", async () => {
  const app = fixture();
  mountTurnActions(app)();
  expect(mocks.user.hidden).toBe(false);
  expect(mocks.buttons.get("编辑")!.hidden).toBe(false);
  mocks.buttons.get("编辑")!.click();
  await vi.waitFor(() => expect(app.composerImages!.set).toHaveBeenCalledWith([], [file]));
  expect(app.objectiveInput.value).toBe("");
});

it("regenerates the rewound file-only message without losing its original attachment", async () => {
  const app = fixture();
  mountTurnActions(app)();
  mocks.buttons.get("重新生成")!.click();
  await vi.waitFor(() => expect(app.runAgent).toHaveBeenCalledWith("", [], [file]));
});
