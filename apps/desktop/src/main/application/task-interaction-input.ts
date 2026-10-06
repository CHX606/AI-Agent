import type { TaskInteractionInput } from "../../shared/contracts.js";
import { normalizeImages } from "../../shared/image-input.js";
import { UserFacingError } from "./errors.js";

export function taskInteractionBody(input: TaskInteractionInput) {
  const images = normalizeImages(input.images);
  const action = input.action;
  if (action === "pause" || action === "resume") {
    if (input.images !== undefined) throw new UserFacingError("暂停或继续操作不能包含图片");
    return { action };
  }
  if (!["supplement", "replace", "answer"].includes(action)) throw new UserFacingError("不支持的任务操作");
  if (input.text !== undefined && (typeof input.text !== "string" || input.text.trim().length > 4000)) {
    throw new UserFacingError("补充要求不能超过 4000 字");
  }
  const text = input.text?.trim() ?? "";
  if (!text && !images.length && !(action === "answer" && input.optionId)) throw new UserFacingError("请输入文字或添加图片");
  if (action === "answer" && (typeof input.questionId !== "string" || !input.questionId.trim())) {
    throw new UserFacingError("回答缺少问题编号");
  }
  return { action, ...(input.text !== undefined || action !== "answer" ? { text } : {}),
    ...(images.length ? { images } : {}),
    ...(input.questionId !== undefined ? { question_id: input.questionId } : {}),
    ...(input.optionId !== undefined ? { option_id: input.optionId } : {}) };
}
