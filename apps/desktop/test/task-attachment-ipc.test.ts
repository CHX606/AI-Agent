import { beforeEach, expect, test, vi } from "vitest";
import type { DesktopServices } from "../src/main/application/ports.js";
import { registerTaskIpc } from "../src/main/transport/task-ipc.js";

vi.mock("electron", () => ({ app:{ getPath:() => "user-data" } }));
const attachment = { name:"notes.txt", mime_type:"text/plain", data_url:"data:text/plain;base64,aGVsbG8=" };
const image = { name:"test.png", mime_type:"image/png" as const, data_url:"data:image/png;base64,iVBORw0KGgo=" };
const request = vi.fn(async () => ({ task_id:"task" }));
const handlers = new Map<string, (...args:any[]) => unknown>();

beforeEach(() => {
  request.mockClear(); handlers.clear();
  const services = { gatewayClient:{ request }, readExecutionSettings:() => ({ maxToolRounds:100, acceptanceMode:"auto" }) } as unknown as DesktopServices;
  registerTaskIpc(services, (channel, listener) => handlers.set(channel, listener));
});

test("existing creation IPC transmits ordinary attachment-only and mixed messages", async () => {
  for (const images of [undefined, [image]]) await handlers.get("tasks:create")!(null, {
    gatewayUrl:"http://localhost:3000", workspaceRoot:"D:/project", objective:"", attachments:[attachment], ...(images ? { images } : {}),
  });
  const bodies = (request.mock.calls as unknown as [string, string, RequestInit][]).map(call => JSON.parse(String(call[2].body)));
  expect(bodies[0]).toMatchObject({ objective:"", attachments:[attachment] });
  expect(bodies[1]).toMatchObject({ images:[image], attachments:[attachment] });
});

test("interaction IPC retains ordinary attachments and maps the existing question field", async () => {
  await handlers.get("tasks:interact")!(null, { gatewayUrl:"http://localhost:3000", taskId:"task", action:"answer", questionId:"q", attachments:[attachment] });
  const call = request.mock.calls[0] as unknown as [string, string, RequestInit];
  expect(JSON.parse(String(call[2].body))).toEqual({ action:"answer", question_id:"q", attachments:[attachment] });
});

test("invalid ordinary uploads and forbidden actions never reach HTTP", () => {
  expect(() => handlers.get("tasks:create")!(null, { objective:"", workspaceRoot:"D:/project", attachments:[{ ...attachment, name:"../private.txt" }] })).toThrow();
  expect(() => handlers.get("tasks:interact")!(null, { gatewayUrl:"http://localhost:3000", taskId:"task", action:"pause", attachments:[attachment] })).toThrow();
  expect(request).not.toHaveBeenCalled();
});
