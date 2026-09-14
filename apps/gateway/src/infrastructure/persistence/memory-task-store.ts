import { randomUUID } from "node:crypto";

import type { CreateTaskBody, TaskEvent, TaskRecord } from "../../domain/protocol.js";
import { DEFAULT_MAX_TOOL_ROUNDS, terminalTaskStatuses } from "../../domain/protocol.js";
import type { CancellationResult, TaskStore } from "../../application/ports/task-store.js";

export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly events = new Map<string, TaskEvent[]>();

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
