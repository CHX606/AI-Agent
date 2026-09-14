import type { CreateTaskInput } from "../../shared/contracts.js";
import { parseExecutionSettings, type ExecutionSettings } from "../../shared/execution-settings.js";

export function taskRequestBody(input: CreateTaskInput, settings: ExecutionSettings) {
  if (!input.objective.trim() || !input.workspaceRoot.trim()) {
    throw new Error("工作区和任务描述不能为空");
  }
  return {
    objective: input.objective.trim(),
    workspace_root: input.workspaceRoot.trim(),
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    ...(input.multiAgentMode ? { multi_agent_mode: input.multiAgentMode } : {}),
    permission_mode: input.permissionMode ?? "confirm",
    max_tool_rounds: parseExecutionSettings(settings).maxToolRounds,
  };
}
