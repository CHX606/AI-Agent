import { describe, expect, it } from "vitest";
import { taskRequestBody } from "../src/main/application/task-input.js";
import { taskInteractionBody } from "../src/main/application/task-interaction-input.js";
import type { FileAttachment } from "../src/shared/attachment-input.js";

const attachment = { name:"notes.txt", mime_type:"text/plain", data_url:"data:text/plain;base64,aGVsbG8=" };
const image = { name:"test.png", mime_type:"image/png" as const, data_url:"data:image/png;base64,iVBORw0KGgo=" };
const settings = { maxToolRounds:100, acceptanceMode:"auto" as const };
const task = { gatewayUrl:"http://localhost:3000", objective:"", workspaceRoot:"D:/project" };
const interaction = { gatewayUrl:task.gatewayUrl, taskId:"task", text:"" };

function bigFile(size:number): FileAttachment {
  return { name:"large.txt", mime_type:"text/plain", data_url:`data:text/plain;base64,${Buffer.alloc(size).toString("base64")}` };
}

describe("desktop ordinary attachment task bodies", () => {
  it.each([undefined, "session-1"])("supports attachment-only tasks and continuation (%s)", sessionId => {
    const body = taskRequestBody({ ...task, attachments:[attachment], ...(sessionId ? { sessionId } : {}) }, settings);
    expect(body).toMatchObject({ objective:"", attachments:[attachment] });
    expect(body.session_id).toBe(sessionId);
    expect(body).not.toHaveProperty("images");
  });

  it("keeps image and ordinary attachment fields separate in mixed input", () => {
    expect(taskRequestBody({ ...task, images:[image], attachments:[attachment] }, settings))
      .toMatchObject({ images:[image], attachments:[attachment] });
    expect(taskRequestBody({ ...task, objective:"hello" }, settings)).not.toHaveProperty("attachments");
  });

  it.each(["supplement", "replace", "answer"] as const)("accepts attachment-only %s", action => {
    expect(taskInteractionBody({ ...interaction, action, attachments:[attachment], ...(action === "answer" ? { questionId:"q" } : {}) }))
      .toMatchObject({ action, attachments:[attachment], text:"" });
  });

  it.each(["pause", "resume"] as const)("rejects attachments on %s, including an empty field", action => {
    for (const attachments of [[], [attachment]]) expect(() => taskInteractionBody({ ...interaction, action, attachments })).toThrow("不能包含附件");
  });

  it.each([
    { ...attachment, name:"../secret.txt" }, { ...attachment, mime_type:"" },
    { ...attachment, data_url:"https://example.com/notes.txt" }, { ...attachment, data_url:"data:text/plain;base64,AB==" },
  ])("rejects invalid attachment input before transport (%s)", invalid => {
    expect(() => taskRequestBody({ ...task, attachments:[invalid] }, settings)).toThrow();
    expect(() => taskInteractionBody({ ...interaction, action:"supplement", attachments:[invalid] })).toThrow();
  });

  it("enforces a combined count and decoded-byte budget", () => {
    expect(() => taskRequestBody({ ...task, images:[image], attachments:Array.from({ length:5 }, () => attachment) }, settings)).toThrow("5");
    const maximum = bigFile(5 * 1024 * 1024);
    const attachments = Array.from({ length:4 }, () => maximum);
    expect(taskRequestBody({ ...task, attachments }, settings).attachments).toHaveLength(4);
    expect(() => taskRequestBody({ ...task, images:[image], attachments }, settings)).toThrow("20 MiB");
    expect(() => taskInteractionBody({ ...interaction, action:"supplement", images:[image], attachments })).toThrow("20 MiB");
  });
});
