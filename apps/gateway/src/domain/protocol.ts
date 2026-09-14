import { z } from "zod";

export const DEFAULT_MAX_TOOL_ROUNDS = 100;
export const maxToolRoundsSchema = z.number().int().min(1).max(1000);

export const taskStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "PAUSE_REQUESTED",
  "PAUSED",
  "WAITING_FOR_INPUT",
  "CANCELLATION_REQUESTED",
  "CANCELLED",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const terminalTaskStatuses = new Set<TaskStatus>([
  "CANCELLED",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
]);

export const createTaskBodySchema = z.object({
  objective: z.string().trim().min(1).max(4_000),
  workspace_root: z.string().trim().min(1).max(4_096),
  session_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u).optional(),
  multi_agent_mode: z.enum(["off", "on", "auto"]).optional(),
  permission_mode: z.enum(["read_only", "confirm", "edit"]).optional(),
  max_tool_rounds: maxToolRoundsSchema.optional(),
}).strict();

export type CreateTaskBody = z.infer<typeof createTaskBodySchema>;

export const taskInteractionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }).strict(),
  z.object({ action: z.literal("resume") }).strict(),
  z.object({ action: z.literal("supplement"), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ action: z.literal("replace"), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({
    action: z.literal("answer"), question_id: z.string().min(1).max(128),
    option_id: z.string().min(1).max(64).optional(),
    text: z.string().trim().min(1).max(4000).optional(),
  }).strict(),
]);
export type TaskInteractionBody = z.infer<typeof taskInteractionSchema>;

export interface TaskRecord {
  task_id: string;
  max_tool_rounds?: number;
  session_id?: string;
  multi_agent_mode?: "off" | "on" | "auto";
  status: TaskStatus;
  objective: string;
  workspace_root: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  worker_id: string | null;
  run_id: string | null;
  result: unknown | null;
  error: string | null;
}

export interface TaskEvent {
  id: string;
  event_type: string;
  data: unknown;
}
