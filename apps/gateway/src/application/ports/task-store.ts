import type { CreateTaskBody, TaskEvent, TaskRecord, TaskInteractionBody } from "../../domain/protocol.js";

export interface CancellationResult {
  found: boolean;
  changed: boolean;
  task: TaskRecord | null;
}

export interface TaskStore {
  health?(): Promise<"ready" | "unavailable" | "stopped">;
  diagnosticSnapshot?(taskId?: string): Promise<Record<string, unknown>>;
  createTask(input: CreateTaskBody): Promise<TaskRecord>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  requestCancellation(taskId: string): Promise<CancellationResult>;
  interactTask?(taskId: string, input: TaskInteractionBody): Promise<TaskRecord>;
  readEvents(taskId: string, afterId: string, blockMs: number): Promise<TaskEvent[]>;
  listSessions?(offset?: number): Promise<Record<string, unknown>>;
  getSession?(sessionId: string): Promise<Record<string, unknown> | null>;
  setSessionMode?(sessionId: string, mode: string): Promise<Record<string, unknown> | null>;
  getChanges?(taskId: string): Promise<Record<string, unknown>>;
  reviewChange?(taskId: string, changeId: string, action: string): Promise<Record<string, unknown>>;
  configureModel?(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  close?(): Promise<void>;
}
