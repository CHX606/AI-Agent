import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDiagnostics } from "@bit-agent/diagnostics";
import { buildApp } from "../src/bootstrap.js";
import { createTaskBodySchema, taskInteractionSchema } from "../src/domain/protocol.js";
import { IMAGE_LIMITS, imagesSchema } from "../src/domain/image-input.js";
import { MemoryTaskStore } from "../src/infrastructure/persistence/memory-task-store.js";

function png(bytes = 24) {
  const data = Buffer.alloc(bytes); Buffer.from("89504e470d0a1a0a", "hex").copy(data);
  return { name: "截图.png", mime_type: "image/png" as const, data_url: `data:image/png;base64,${data.toString("base64")}` };
}
const task = { objective: "inspect", workspace_root: "D:/project" };

describe("image protocol and HTTP transport", () => {
  it("keeps plain inputs plain and requires actual user content", () => {
    expect(createTaskBodySchema.parse(task)).toEqual(task);
    expect(taskInteractionSchema.parse({ action: "supplement", text: "hi" })).toEqual({ action: "supplement", text: "hi" });
    expect(createTaskBodySchema.safeParse({ ...task, objective: "", images: [] }).success).toBe(false);
    expect(createTaskBodySchema.parse({ ...task, objective: "", images: [png()] }).images).toHaveLength(1);
    expect(taskInteractionSchema.safeParse({ action: "answer", question_id: "q" }).success).toBe(false);
    expect(taskInteractionSchema.safeParse({ action: "answer", question_id: "q", option_id: "approve" }).success).toBe(true);
  });

  it.each(["supplement", "replace", "answer"])("accepts images-only %s", action => {
    const input = { action, text: "", images: [png()], ...(action === "answer" ? { question_id: "q" } : {}) };
    expect(taskInteractionSchema.safeParse(input).success).toBe(true);
    expect(taskInteractionSchema.safeParse({ ...input, images: [] }).success).toBe(false);
  });

  it.each(["pause", "resume"])("does not accept images on %s", action => {
    expect(taskInteractionSchema.safeParse({ action, images: [png()] }).success).toBe(false);
  });

  it.each([
    ["image/png", "89504e470d0a1a0a"], ["image/jpeg", "ffd8ffe0"],
    ["image/webp", "524946460000000057454250"], ["image/gif", "474946383961"],
  ])("validates the %s signature without changing image data", (mime_type, signature) => {
    const data_url = `data:${mime_type};base64,${Buffer.from(signature, "hex").toString("base64")}`;
    const input = [{ name: "image", mime_type, data_url }];
    expect(imagesSchema.parse(input)).toEqual(input);
  });

  it.each([
    ["path name", { ...png(), name: "../x" }], ["control name", { ...png(), name: "x\u0000" }],
    ["drive-relative name", { ...png(), name: "C:image.png" }], ["C1 control name", { ...png(), name: "image\u0085.png" }],
    ["edge control name", { ...png(), name: "\nimage.png\n" }],
    ["unsupported MIME", { ...png(), mime_type: "image/svg+xml" }], ["mismatched MIME", { ...png(), mime_type: "image/jpeg" }],
    ["remote URL", { ...png(), data_url: "https://example.com/image.png" }],
    ["invalid base64", { ...png(), data_url: "data:image/png;base64,%%%%" }],
    ["non-canonical base64", { ...png(), data_url: "data:image/png;base64,iVBORw0KGgp=" }],
    ["bad signature", { ...png(), data_url: "data:image/png;base64,YWJjZA==" }],
    ["extra field", { ...png(), path: "C:/secret" }],
  ])("rejects %s", (_label, input) => {
    expect(imagesSchema.safeParse([input]).success).toBe(false);
  });

  it("enforces exact decoded-byte limits and count independently", () => {
    const maximum = png(IMAGE_LIMITS.maxImageBytes);
    expect(imagesSchema.safeParse([maximum]).success).toBe(true);
    expect(imagesSchema.safeParse([png(IMAGE_LIMITS.maxImageBytes + 1)]).success).toBe(false);
    expect(imagesSchema.safeParse(Array.from({ length: 4 }, () => maximum)).success).toBe(true);
    expect(imagesSchema.safeParse([...Array.from({ length: 4 }, () => maximum), png()]).success).toBe(false);
    expect(imagesSchema.safeParse(Array.from({ length: 6 }, () => png())).success).toBe(false);
  });

  it("transmits images for create, continued tasks and all content interactions", async () => {
    const store = new MemoryTaskStore();
    const app = buildApp({ logger: false, taskStore: store });
    try {
      const image = png(1024 * 1024);
      for (const session_id of [undefined, "session-1"]) {
        const created = await app.inject({ method: "POST", url: "/v1/tasks", payload: {
          ...task, objective: "", images: [image], ...(session_id ? { session_id } : {}),
        } });
        expect(created.statusCode).toBe(202);
        const saved = created.json();
        expect(saved.images[0].data_url.length).toBe(image.data_url.length);
        for (const action of ["supplement", "replace", "answer"]) {
          const response = await app.inject({ method: "POST", url: `/v1/tasks/${saved.task_id}/interaction`, payload: {
            action, text: "", images: [png()], ...(action === "answer" ? { question_id: "q" } : {}),
          } });
          expect(response.statusCode).toBe(200);
        }
        const fetched = (await app.inject({ url: `/v1/tasks/${saved.task_id}` })).json();
        expect(fetched.images[0].data_url.length).toBe(image.data_url.length);
        expect(fetched.intent_updates.map((update: { kind: string }) => update.kind)).toEqual(["supplement", "replace", "answer"]);
      }
    } finally { await app.close(); }
  });

  it.each(["/v1/tasks", "/v1/tasks/t/interaction"])("rejects %s above the 28 MiB body limit", async url => {
    const app = buildApp({ logger: false });
    try {
      const response = await app.inject({ method: "POST", url, headers: { "content-type": "application/json" },
        payload: " ".repeat(IMAGE_LIMITS.maxRequestBytes + 1) });
      expect(response.statusCode).toBe(413);
      expect(response.json().user_message).toContain("减少图片");
    } finally { await app.close(); }
  });

  it("keeps the original limit on non-image routes", async () => {
    const app = buildApp({ logger: false });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/model", payload: { model: "x".repeat(2 * 1024 * 1024) } });
      expect(response.statusCode).toBe(413);
    } finally { await app.close(); }
  });

  it("does not include image bodies in diagnostic snapshots or logs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-image-diagnostics-"));
    const diagnostics = createDiagnostics({ process: "gateway", directory });
    const app = buildApp({ taskStore: new MemoryTaskStore(), diagnostics });
    const image = png(256);
    try {
      const taskId = (await app.inject({ method: "POST", url: "/v1/tasks", payload: { ...task, images: [image] } })).json().task_id;
      const snapshot = (await app.inject({ url: `/v1/diagnostics?task_id=${taskId}` })).body;
      expect(snapshot).not.toContain("data_url");
      expect(snapshot).not.toContain(image.data_url);
      await app.inject({ method: "POST", url: "/v1/tasks", payload: { ...task, images: [{ ...image, name: "../bad" }] } });
    } finally { await app.close(); await diagnostics.close(); }
    const logs = readFileSync(join(directory, "gateway", "current.jsonl"), "utf8");
    expect(logs).not.toContain(image.data_url);
    expect(logs).not.toContain(image.data_url.split(",")[1]);
  });
});
