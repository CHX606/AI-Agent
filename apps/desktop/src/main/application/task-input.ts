import type { CreateTaskInput } from "../../shared/contracts.js";
import { parseExecutionSettings, type ExecutionSettings } from "../../shared/execution-settings.js";
import { normalizeImages } from "../../shared/image-input.js";
import { normalizeAttachments, validateUploadLimits } from "../../shared/attachment-input.js";
import { UserFacingError } from "./errors.js";

export function taskRequestBody(input: CreateTaskInput, settings: ExecutionSettings) {
  const images = normalizeImages(input?.images);
  const attachments = normalizeAttachments(input?.attachments);
  validateUploadLimits(images, attachments);
  if (typeof input?.objective !== "string" || typeof input.workspaceRoot !== "string"
    || !input.workspaceRoot.trim() || (!input.objective.trim() && !images.length && !attachments.length)) {
    throw new UserFacingError("请选择工作区，并输入任务描述或添加图片");
  }
  if (input.objective.trim().length > 4000 || input.workspaceRoot.trim().length > 4096) {
    throw new UserFacingError("任务描述不能超过 4000 字，工作区路径不能超过 4096 字");
  }
  const parsed = parseExecutionSettings(settings);
  return {
    objective: input.objective.trim(),
    workspace_root: input.workspaceRoot.trim(),
    ...(images.length ? { images } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    ...(input.multiAgentMode ? { multi_agent_mode: input.multiAgentMode } : {}),
    permission_mode: input.permissionMode ?? "confirm",
    max_tool_rounds: parsed.maxToolRounds,
    acceptance_mode: parsed.acceptanceMode,
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
  };
}
