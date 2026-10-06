import { describe, expect, it } from "vitest";
import { taskRequestBody } from "../src/main/application/task-input.js";
import { taskInteractionBody } from "../src/main/application/task-interaction-input.js";
import type { TaskInteractionInput } from "../src/shared/contracts.js";

const image = { name: "test.png", mime_type: "image/png" as const, data_url: "data:image/png;base64,iVBORw0KGgo=" };
const settings = { maxToolRounds: 100, acceptanceMode: "auto" as const };
const task = { gatewayUrl: "http://localhost:3000", objective: "inspect", workspaceRoot: "D:/project" };
const interaction = { gatewayUrl: task.gatewayUrl, taskId: "task" };

describe("desktop multimodal task bodies", () => {
  it("keeps the original plain task body and optional images out of plain interactions", () => {
    expect(taskRequestBody(task, settings)).toEqual({ objective: "inspect", workspace_root: "D:/project",
      permission_mode: "confirm", max_tool_rounds: 100, acceptance_mode: "auto" });
    expect(taskInteractionBody({ ...interaction, action: "supplement", text: " hi " })).toEqual({ action: "supplement", text: "hi" });
    expect(taskInteractionBody({ ...interaction, action: "answer", questionId: "q", optionId: "approve" }))
      .toEqual({ action: "answer", question_id: "q", option_id: "approve" });
    expect(taskInteractionBody({ ...interaction, action: "pause" })).toEqual({ action: "pause" });
  });

  it.each([undefined, "session-1"])("sends images for new and continued tasks (%s)", sessionId => {
    const input = { ...task, objective: "", images: [image], ...(sessionId ? { sessionId } : {}) };
    const body = taskRequestBody(input, settings);
    expect(body.images).toEqual([image]);
    expect(body.objective).toBe("");
    expect(body.session_id).toBe(sessionId);
    expect(() => taskRequestBody({ ...task, objective: " " }, settings)).toThrow("任务描述");
  });

  it.each(["supplement", "replace", "answer"] as const)("supports image-only %s", action => {
    const body = taskInteractionBody({ ...interaction, action, text: "", images: [image],
      ...(action === "answer" ? { questionId: "q" } : {}) });
    expect(body).toMatchObject({ images: [image], text: "" });
    expect(() => taskInteractionBody({ ...interaction, action, text: "", ...(action === "answer" ? { questionId: "q" } : {}) })).toThrow();
  });

  it.each(["pause", "resume"] as const)("rejects images on %s", action => {
    expect(() => taskInteractionBody({ ...interaction, action, images: [image] })).toThrow("不能包含图片");
  });

  it("validates types and image fields before issuing a request", () => {
    expect(() => taskRequestBody({ ...task, images: [{ ...image, name: "../x" }] }, settings)).toThrow("文件名");
    expect(() => taskRequestBody({ ...task, objective: 3 } as unknown as typeof task, settings)).toThrow();
    expect(() => taskRequestBody({ ...task, objective: "x".repeat(4001) }, settings)).toThrow("4000");
    expect(() => taskRequestBody({ ...task, workspaceRoot: "x".repeat(4097) }, settings)).toThrow("4096");
    expect(() => taskInteractionBody({ ...interaction, action: "answer", images: [image] })).toThrow("问题编号");
    expect(() => taskInteractionBody({ ...interaction, action: "supplement", text: 3 } as unknown as TaskInteractionInput)).toThrow();
  });
});
