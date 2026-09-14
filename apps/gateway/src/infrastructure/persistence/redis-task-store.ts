import { randomUUID } from "node:crypto";

import { createClient, type RedisClientType } from "redis";

import type { CreateTaskBody, TaskEvent, TaskRecord, TaskStatus } from "../../domain/protocol.js";
import { DEFAULT_MAX_TOOL_ROUNDS, taskStatusSchema } from "../../domain/protocol.js";
import type { CancellationResult, TaskStore } from "../../application/ports/task-store.js";

const CANCEL_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return -1 end
if status == 'CANCELLED' or status == 'COMPLETED' or status == 'PARTIAL' or status == 'FAILED' then
  return 0
end
if status == 'QUEUED' then
  redis.call('HSET', KEYS[1], 'status', 'CANCELLED', 'updated_at', ARGV[1], 'completed_at', ARGV[1])
  return 1
end
redis.call('HSET', KEYS[1], 'status', 'CANCELLATION_REQUESTED', 'updated_at', ARGV[1])
return 2
`;

export interface RedisTaskStoreOptions {
  keyPrefix?: string;
  queueKey?: string;
  taskTtlSeconds?: number;
}

export class RedisTaskStore implements TaskStore {
  private constructor(
    private readonly client: RedisClientType,
    private readonly eventClient: RedisClientType,
    private readonly keyPrefix: string,
    private readonly queueKey: string,
    private readonly taskTtlSeconds: number,
  ) {}

  static async connect(
    url: string,
    options: RedisTaskStoreOptions = {},
  ): Promise<RedisTaskStore> {
    const client = createClient({ url });
    const eventClient = client.duplicate();
    await Promise.all([client.connect(), eventClient.connect()]);
    return new RedisTaskStore(
      client,
      eventClient,
      options.keyPrefix ?? "bit-agent:tasks",
      options.queueKey ?? "bit-agent:tasks:queue",
      options.taskTtlSeconds ?? 7 * 24 * 60 * 60,
    );
  }

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
    const key = this.taskKey(task.task_id);
    const transaction = this.client.multi();
    transaction.hSet(key, serializeTask(task));
    transaction.expire(key, this.taskTtlSeconds);
    transaction.rPush(this.queueKey, JSON.stringify({
      task_id: task.task_id,
      objective: task.objective,
      workspace_root: task.workspace_root,
      created_at: task.created_at,
      max_tool_rounds: task.max_tool_rounds,
    }));
    await transaction.exec();
    return task;
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const values = await this.client.hGetAll(this.taskKey(taskId));
    if (!values["task_id"]) {
      return null;
    }
    return parseTask(values);
  }

  async requestCancellation(taskId: string): Promise<CancellationResult> {
    const result = Number(await this.client.eval(CANCEL_SCRIPT, {
      keys: [this.taskKey(taskId)],
      arguments: [new Date().toISOString()],
    }));
    const task = result === -1 ? null : await this.getTask(taskId);
    return {
      found: result !== -1,
      changed: result > 0,
      task,
    };
  }

  async readEvents(taskId: string, afterId: string, blockMs: number): Promise<TaskEvent[]> {
    const streams = await this.eventClient.xRead(
      { key: this.eventKey(taskId), id: afterId },
      { COUNT: 100, BLOCK: blockMs },
    );
    if (!streams) {
      return [];
    }
    const events: TaskEvent[] = [];
    for (const stream of streams) {
      for (const message of stream.messages) {
        const raw = message.message["event"];
        if (typeof raw !== "string") {
          continue;
        }
        try {
          const data: unknown = JSON.parse(raw);
          const eventType = extractEventType(data);
          events.push({ id: message.id, event_type: eventType, data });
        } catch {
          events.push({ id: message.id, event_type: "MALFORMED_EVENT", data: raw });
        }
      }
    }
    return events;
  }

  async close(): Promise<void> {
    await Promise.all([this.client.close(), this.eventClient.close()]);
  }

  private taskKey(taskId: string): string {
    return `${this.keyPrefix}:${taskId}`;
  }

  private eventKey(taskId: string): string {
    return `${this.taskKey(taskId)}:events`;
  }
}

function serializeTask(task: TaskRecord): Record<string, string> {
  return {
    task_id: task.task_id,
    status: task.status,
    objective: task.objective,
    workspace_root: task.workspace_root,
    max_tool_rounds: String(task.max_tool_rounds ?? DEFAULT_MAX_TOOL_ROUNDS),
    created_at: task.created_at,
    updated_at: task.updated_at,
    started_at: task.started_at ?? "",
    completed_at: task.completed_at ?? "",
    worker_id: task.worker_id ?? "",
    run_id: task.run_id ?? "",
    result_json: task.result === null ? "" : JSON.stringify(task.result),
    error: task.error ?? "",
  };
}

function parseTask(values: Record<string, string>): TaskRecord {
  const status: TaskStatus = taskStatusSchema.parse(values["status"]);
  const resultJson = values["result_json"] ?? "";
  return {
    task_id: values["task_id"] ?? "",
    status,
    objective: values["objective"] ?? "",
    workspace_root: values["workspace_root"] ?? "",
    ...(values["max_tool_rounds"] ? { max_tool_rounds: Number(values["max_tool_rounds"]) } : {}),
    created_at: values["created_at"] ?? "",
    updated_at: values["updated_at"] ?? "",
    started_at: emptyToNull(values["started_at"]),
    completed_at: emptyToNull(values["completed_at"]),
    worker_id: emptyToNull(values["worker_id"]),
    run_id: emptyToNull(values["run_id"]),
    result: resultJson ? JSON.parse(resultJson) as unknown : null,
    error: emptyToNull(values["error"]),
  };
}

function emptyToNull(value: string | undefined): string | null {
  return value ? value : null;
}

function extractEventType(data: unknown): string {
  if (typeof data !== "object" || data === null || !("event_type" in data)) {
    return "agent_event";
  }
  const eventType = (data as { event_type?: unknown }).event_type;
  return typeof eventType === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(eventType)
    ? eventType
    : "agent_event";
}
