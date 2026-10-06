import { beforeEach, expect, test, vi } from "vitest";
import type { DesktopServices } from "../src/main/application/ports.js";
import { registerTaskIpc } from "../src/main/transport/task-ipc.js";

vi.mock("electron", () => ({ app: { getPath: () => "user-data" } }));
const image = { name: "test.png", mime_type: "image/png" as const, data_url: "data:image/png;base64,iVBORw0KGgo=" };
const request = vi.fn(async () => ({ task_id: "task" }));
const handlers = new Map<string, (...args: any[]) => unknown>();

beforeEach(() => {
  request.mockClear(); handlers.clear();
  const services = { gatewayClient: { request },
    readExecutionSettings: () => ({ maxToolRounds: 100, acceptanceMode: "auto" }) } as unknown as DesktopServices;
  registerTaskIpc(services, (channel, listener) => handlers.set(channel, listener));
});

test("creation IPC sends image-only new and continued task bodies without adding a channel", async () => {
  for (const sessionId of [undefined, "session"]) {
    await handlers.get("tasks:create")!(null, { gatewayUrl: "http://localhost:3000", objective: "", workspaceRoot: "D:/project",
      images: [image], ...(sessionId ? { sessionId } : {}) });
  }
  const calls = request.mock.calls as unknown as [string, string, RequestInit][];
  expect(calls.map(call => call[1])).toEqual(["/v1/tasks", "/v1/tasks"]);
  expect(calls.map(call => JSON.parse(String(call[2].body)).images)).toEqual([[image], [image]]);
  expect(JSON.parse(String(calls[1]![2].body)).session_id).toBe("session");
});

test("interaction IPC preserves attachments and existing question field mapping", async () => {
  await handlers.get("tasks:interact")!(null, { gatewayUrl: "http://localhost:3000", taskId: "task",
    action: "answer", questionId: "question", text: "", images: [image] });
  const call = request.mock.calls[0] as unknown as [string, string, RequestInit];
  expect(call[1]).toBe("/v1/tasks/task/interaction");
  expect(JSON.parse(String(call[2].body))).toEqual({ action: "answer", question_id: "question", text: "", images: [image] });
});

test("invalid attachments cannot reach the HTTP client through IPC", () => {
  expect(() => handlers.get("tasks:create")!(null, { objective: "inspect", workspaceRoot: "D:/project",
    images: [{ ...image, name: "../secret" }] })).toThrow("文件名");
  expect(() => handlers.get("tasks:interact")!(null, { gatewayUrl: "http://localhost:3000", taskId: "task",
    action: "pause", images: [image] })).toThrow("不能包含图片");
  expect(request).not.toHaveBeenCalled();
});
