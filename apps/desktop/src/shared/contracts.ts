import type { ExecutionSettings } from "./execution-settings.js";

export interface CreateTaskInput {
  gatewayUrl: string;
  objective: string;
  workspaceRoot: string;
  sessionId?: string;
  multiAgentMode?: MultiAgentMode;
  permissionMode?: "read_only" | "confirm" | "edit";
}

export type MultiAgentMode = "off" | "on" | "auto";

export interface SessionRequestInput {
  gatewayUrl: string;
  sessionId: string;
}

export interface TaskRequestInput {
  gatewayUrl: string;
  taskId: string;
}

export interface TaskInteractionInput extends TaskRequestInput {
  action: "pause" | "resume" | "supplement" | "replace" | "answer";
  text?: string;
  questionId?: string;
  optionId?: string;
}

export interface RepositoryPathInput {
  path: string;
}

export interface RepositoryEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

export interface RepositoryDirectoryResult {
  path: string;
  entries: RepositoryEntry[];
  truncated: boolean;
}

export interface RepositoryFileResult {
  path: string;
  content: string;
  size: number;
  modifiedAt: string;
  truncated: boolean;
}

export interface TaskEvent {
  taskId?: string;
  id: string | null;
  event_type: string;
  data: unknown;
}

export type ColorTheme = "light" | "dark";

export interface DesktopApi {
  reportClientError(input: { kind: "exception" | "rejection"; taskId?: string; line?: number }): Promise<string>;
  diagnosticStatus(input: { gatewayUrl?: string; taskId?: string }): Promise<Record<string, unknown>>;
  exportDiagnostics(input: { gatewayUrl?: string; taskId?: string }): Promise<Record<string, unknown>>;
  readonly colorTheme: ColorTheme;
  readonly runtimeConfig: { managed: boolean; gatewayUrl: string; startupError: string };
  getChanges(input: TaskRequestInput): Promise<Record<string, unknown>>;
  reviewChange(input: TaskRequestInput & { changeId: string; action: "accept" | "undo" }): Promise<Record<string, unknown>>;
  getModelSettings(): Promise<Record<string, unknown>>;
  saveModelSettings(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  getExecutionSettings(): Promise<ExecutionSettings>;
  saveExecutionSettings(input: ExecutionSettings): Promise<ExecutionSettings>;
  setTheme(theme: ColorTheme): void;
  selectWorkspace(): Promise<string | null>;
  setRepositoryWorkspace(workspaceRoot: string): Promise<string>;
  listRepositoryDirectory(input: RepositoryPathInput): Promise<RepositoryDirectoryResult>;
  readRepositoryFile(input: RepositoryPathInput): Promise<RepositoryFileResult>;
  health(gatewayUrl: string): Promise<unknown>;
  createTask(input: CreateTaskInput): Promise<Record<string, unknown>>;
  listSessions(gatewayUrl: string, offset?: number): Promise<Record<string, unknown>>;
  getSession(input: SessionRequestInput): Promise<Record<string, unknown>>;
  setSessionMode(input: SessionRequestInput & { mode: MultiAgentMode }): Promise<Record<string, unknown>>;
  getTask(input: TaskRequestInput): Promise<Record<string, unknown>>;
  getResult(input: TaskRequestInput): Promise<Record<string, unknown>>;
  cancelTask(input: TaskRequestInput): Promise<Record<string, unknown>>;
  interactTask(input: TaskInteractionInput): Promise<Record<string, unknown>>;
  watchTask(input: TaskRequestInput): void;
  unwatchTask(taskId: string): void;
  onTaskEvent(listener: (event: TaskEvent) => void): () => void;
}
