import type { CreateTaskBody, TaskEvent, TaskRecord, TaskInteractionBody } from "../../domain/protocol.js";

export interface CancellationResult {
  found: boolean;
  changed: boolean;
  task: TaskRecord | null;
}

export interface TaskStore {
  health(): Promise<"ready" | "unavailable" | "stopped">;
  diagnosticSnapshot(taskId?: string): Promise<Record<string, unknown>>;
  createTask(input: CreateTaskBody): Promise<TaskRecord>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  requestCancellation(taskId: string): Promise<CancellationResult>;
  interactTask(taskId: string, input: TaskInteractionBody): Promise<TaskRecord>;
  readEvents(taskId: string, afterId: string, blockMs: number): Promise<TaskEvent[]>;
  /** query 非空时只返回标题、要求或回答中包含它的对话。 */
  listSessions(offset?: number, query?: string): Promise<Record<string, unknown>>;
  getSession(sessionId: string): Promise<Record<string, unknown> | null>;
  setSessionMode(sessionId: string, mode: string): Promise<Record<string, unknown> | null>;
  renameSession(sessionId: string, title: string): Promise<Record<string, unknown>>;
  /** 删除对话的全部记录和改动快照；正在执行的对话会被拒绝。 */
  deleteSession(sessionId: string): Promise<Record<string, unknown>>;
  getChanges(taskId: string): Promise<Record<string, unknown>>;
  reviewChange(taskId: string, changeId: string, action: string): Promise<Record<string, unknown>>;
  /** 任务改过的文件在 Git 里的状态；只提交这些文件。 */
  gitStatus(taskId: string): Promise<Record<string, unknown>>;
  suggestCommitMessage(taskId: string): Promise<Record<string, unknown>>;
  commitChanges(taskId: string, input: { message: string; branch?: string }): Promise<Record<string, unknown>>;
  configureModel(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 用一次真实请求测试模型配置，不改变当前生效的配置。 */
  testModel(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 长期记忆；workspaceRoot 为空时返回所有项目的记忆。 */
  listMemories(workspaceRoot?: string): Promise<Record<string, unknown>>;
  deleteMemory(memoryId: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
