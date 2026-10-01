import { randomUUID } from "node:crypto";

import type { CreateTaskBody, TaskEvent, TaskInteractionBody, TaskRecord } from "../../domain/protocol.js";
import { DEFAULT_MAX_TOOL_ROUNDS, terminalTaskStatuses } from "../../domain/protocol.js";
import type { CancellationResult, TaskStore } from "../../application/ports/task-store.js";

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

/** 测试用的内存实现：只保存任务和事件，其余操作给出最简单的合法结果。 */
export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly events = new Map<string, TaskEvent[]>();

  async health(): Promise<"ready"> {
    return "ready";
  }

  async diagnosticSnapshot(taskId?: string): Promise<Record<string, unknown>> {
    const tasks = [...this.tasks.values()].filter((task) => !taskId || task.task_id === taskId);
    return { tasks: structuredClone(tasks), events: [] };
  }

  async interactTask(taskId: string, _input: TaskInteractionBody): Promise<TaskRecord> {
    const task = this.tasks.get(taskId);
    if (!task) throw notFound("任务不存在");
    return structuredClone(task);
  }

  async listSessions(_offset = 0): Promise<Record<string, unknown>> {
    return { sessions: [] };
  }

  async getSession(_sessionId: string): Promise<Record<string, unknown> | null> {
    return null;
  }

  async setSessionMode(_sessionId: string, _mode: string): Promise<Record<string, unknown> | null> {
    return null;
  }

  async getChanges(taskId: string): Promise<Record<string, unknown>> {
    if (!this.tasks.has(taskId)) throw notFound("任务不存在");
    return { changes: [] };
  }

  async reviewChange(taskId: string, _changeId: string, _action: string): Promise<Record<string, unknown>> {
    if (!this.tasks.has(taskId)) throw notFound("任务不存在");
    throw notFound("改动不存在");
  }

  async gitStatus(taskId: string): Promise<Record<string, unknown>> {
    if (!this.tasks.has(taskId)) throw notFound("任务不存在");
    return { repository: false, branch: null, files: [], task_files: [] };
  }

  async suggestCommitMessage(taskId: string): Promise<Record<string, unknown>> {
    const task = this.tasks.get(taskId);
    if (!task) throw notFound("任务不存在");
    return { message: task.objective, generated: false };
  }

  async commitChanges(taskId: string, _input: { message: string; branch?: string }): Promise<Record<string, unknown>> {
    if (!this.tasks.has(taskId)) throw notFound("任务不存在");
    throw Object.assign(new Error("工作区不在 Git 仓库里"), { statusCode: 409 });
  }

  async configureModel(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { configured: true, model: input.model, base_url: input.base_url, api: input.api ?? "responses" };
  }

  async testModel(_input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { ok: false, api: null, message: "内存存储不连接真实模型", attempts: [] };
  }

  async listMemories(_workspaceRoot?: string): Promise<Record<string, unknown>> {
    return { enabled: false, memories: [] };
  }

  async deleteMemory(_memoryId: string): Promise<Record<string, unknown>> {
    throw notFound("记忆不存在或已删除");
  }

  async close(): Promise<void> {}

  async createTask(input: CreateTaskBody): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const task: TaskRecord = {
      task_id: randomUUID(),
      status: "QUEUED",
      objective: input.objective,
      workspace_root: input.workspace_root,
      max_tool_rounds: input.max_tool_rounds ?? DEFAULT_MAX_TOOL_ROUNDS,
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null,
      worker_id: null,
      run_id: null,
      result: null,
      error: null,
    };
    this.tasks.set(task.task_id, task);
    this.events.set(task.task_id, []);
    return structuredClone(task);
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : null;
  }

  async requestCancellation(taskId: string): Promise<CancellationResult> {
    const current = this.tasks.get(taskId);
    if (!current) {
      return { found: false, changed: false, task: null };
    }
    if (terminalTaskStatuses.has(current.status)) {
      return { found: true, changed: false, task: structuredClone(current) };
    }

    const now = new Date().toISOString();
    const status = current.status === "QUEUED" ? "CANCELLED" : "CANCELLATION_REQUESTED";
    const updated: TaskRecord = {
      ...current,
      status,
      updated_at: now,
      completed_at: status === "CANCELLED" ? now : null,
    };
    this.tasks.set(taskId, updated);
    return { found: true, changed: true, task: structuredClone(updated) };
  }

  async readEvents(taskId: string, afterId: string): Promise<TaskEvent[]> {
    const events = this.events.get(taskId) ?? [];
    if (afterId === "0-0") {
      return structuredClone(events);
    }
    const index = events.findIndex((event) => event.id === afterId);
    return structuredClone(index < 0 ? events : events.slice(index + 1));
  }

  addEvent(taskId: string, event: TaskEvent): void {
    const events = this.events.get(taskId);
    if (!events) {
      throw new Error(`unknown task: ${taskId}`);
    }
    events.push(structuredClone(event));
  }
}
