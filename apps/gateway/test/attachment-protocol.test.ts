import { describe, expect, it } from "vitest";
import { buildApp } from "../src/bootstrap.js";
import { attachmentsSchema, FILE_LIMITS } from "../src/domain/attachment-input.js";
import { createTaskBodySchema, taskInteractionSchema } from "../src/domain/protocol.js";
import { MemoryTaskStore } from "../src/infrastructure/persistence/memory-task-store.js";

function file(bytes = 5, mime_type = "text/plain") {
  return { name:"notes.txt", mime_type, data_url:`data:${mime_type};base64,${Buffer.alloc(bytes, 97).toString("base64")}` };
}
const image = { name:"test.png", mime_type:"image/png" as const, data_url:"data:image/png;base64,iVBORw0KGgo=" };
const task = { objective:"", workspace_root:"D:/project" };

describe("ordinary attachment validation and task transport", () => {
  it("accepts attachment-only, mixed and empty-file inputs without changing data", () => {
    const attachments = [file()];
    expect(createTaskBodySchema.parse({ ...task, attachments })).toEqual({ ...task, attachments });
    expect(createTaskBodySchema.parse({ ...task, images:[image], attachments })).toMatchObject({ images:[image], attachments });
    expect(attachmentsSchema.parse([file(0, "application/octet-stream")])).toHaveLength(1);
    expect(createTaskBodySchema.safeParse({ ...task, attachments:[] }).success).toBe(false);
  });

  it.each(["supplement", "replace", "answer"])("accepts attachment-only %s", action => {
    const input = { action, attachments:[file()], ...(action === "answer" ? { question_id:"q" } : {}) };
    expect(taskInteractionSchema.parse(input)).toEqual(input);
  });

  it.each(["pause", "resume"])("rejects ordinary attachments on %s", action => {
    for (const attachments of [[], [file()]]) expect(taskInteractionSchema.safeParse({ action, attachments }).success).toBe(false);
  });

  it.each([
    ["null", null], ["object", {}], ["path", [{ ...file(), name:"../notes.txt" }]],
    ["drive-relative", [{ ...file(), name:"C:notes.txt" }]], ["control", [{ ...file(), name:"notes\n.txt" }]],
    ["bad MIME", [{ ...file(), mime_type:"text/plain; charset=utf-8" }]], ["empty MIME", [{ ...file(), mime_type:"" }]],
    ["remote data", [{ ...file(), data_url:"https://example.com/notes.txt" }]],
    ["MIME mismatch", [{ ...file(), mime_type:"application/pdf" }]],
    ["invalid base64", [{ ...file(), data_url:"data:text/plain;base64,%%%" }]],
    ["non-canonical base64", [{ ...file(), data_url:"data:text/plain;base64,AB==" }]],
    ["extra field", [{ ...file(), path:"D:/private.txt" }]],
  ])("rejects %s", (_label, input) => { expect(attachmentsSchema.safeParse(input).success).toBe(false); });

  it("keeps exact size limits and combines image and file budgets", () => {
    const maximum = file(FILE_LIMITS.maxFileBytes);
    expect(attachmentsSchema.safeParse([maximum]).success).toBe(true);
    expect(attachmentsSchema.safeParse([file(FILE_LIMITS.maxFileBytes + 1)]).success).toBe(false);
    const attachments = Array.from({ length:4 }, () => maximum);
    expect(createTaskBodySchema.safeParse({ ...task, attachments }).success).toBe(true);
    expect(createTaskBodySchema.safeParse({ ...task, images:[image], attachments }).success).toBe(false);
    expect(taskInteractionSchema.safeParse({ action:"supplement", images:[image], attachments }).success).toBe(false);
    expect(createTaskBodySchema.safeParse({ ...task, images:[image], attachments:Array.from({ length:5 }, () => file()) }).success).toBe(false);
  });

  it("preserves file bodies through HTTP creation, reads and all content interactions", async () => {
    const app = buildApp({ logger:false, taskStore:new MemoryTaskStore() });
    const attachment = file(1024 * 1024);
    try {
      const response = await app.inject({ method:"POST", url:"/v1/tasks", payload:{ ...task, attachments:[attachment] } });
      expect(response.statusCode).toBe(202);
      const saved = response.json();
      expect(saved.attachments).toEqual([attachment]);
      for (const action of ["supplement", "replace", "answer"]) {
        const interacted = await app.inject({ method:"POST", url:`/v1/tasks/${saved.task_id}/interaction`, payload:{
          action, attachments:[file()], ...(action === "answer" ? { question_id:"q" } : {}),
        } });
        expect(interacted.statusCode).toBe(200);
      }
      const fetched = (await app.inject({ url:`/v1/tasks/${saved.task_id}` })).json();
      expect(fetched.attachments).toEqual([attachment]);
      expect(fetched.intent_updates.map((update:{attachments:unknown[]}) => update.attachments)).toEqual([[file()], [file()], [file()]]);
      const invalid = await app.inject({ method:"POST", url:"/v1/tasks", payload:{ ...task, attachments:[{ ...file(), name:"../bad" }] } });
      expect(invalid.statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
