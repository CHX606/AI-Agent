import type { ExecutionSettings } from "./execution-settings.js";

export interface CreateTaskInput {
  gatewayUrl: string;
  objective: string;
  workspaceRoot: string;
  sessionId?: string;
  multiAgentMode?: MultiAgentMode;
  permissionMode?: "read_only" | "confirm" | "edit";
  /** 本轮临时换用的模型；不填时用模型设置里的主模型。 */
  model?: string;
  /** 思考程度；不填时由模型自己决定。 */
  reasoningEffort?: ReasoningEffort;
}

export type MultiAgentMode = "off" | "on" | "auto";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SessionRequestInput {
  gatewayUrl: string;
  sessionId: string;
}

export interface TaskRequestInput {
  gatewayUrl: string;
  taskId: string;
}

export interface GitCommitInput extends TaskRequestInput {
  message: string;
  /** 填写时先新建并切换到这个分支再提交。 */
  branch?: string;
}

export interface GitStatusResult {
  repository: boolean;
  branch: string | null;
  /** 本次任务的文件里，相对当前提交有改动的那些。 */
  files: { path: string; status: string }[];
  task_files: string[];
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

export interface MemoryListInput {
  gatewayUrl: string;
  /** 为空时列出所有项目的记忆。 */
  workspaceRoot?: string;
}

export interface MemoryDeleteInput {
  gatewayUrl: string;
  memoryId: string;
}

export interface LongTermMemory {
  id: string;
  kind: "FACT" | "DECISION" | "EPISODE" | "PROCEDURE" | "PREFERENCE";
  memory_key: string;
  title: string;
  content: string;
  applicability: string;
  tags: string[];
  project_id: string | null;
  source_run_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface MemoryListResult {
  enabled: boolean;
  memories: LongTermMemory[];
}

/** 外部工具（MCP Server）。env 只在新填写时出现；已保存的只给出变量名 envKeys。 */
export interface McpServer {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  auto_approve: boolean;
  envKeys?: string[];
  env?: Record<string, string>;
}

export interface ModelTestResult {
  ok: boolean;
  api: "responses" | "chat_completions" | null;
  message: string;
  latency_ms?: number;
  attempts?: { api: string; status_code?: number; message: string }[];
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
  readonly runtimeConfig: { managed: boolean; gatewayUrl: string; startupError: string; version?: string; userName?: string };
  getChanges(input: TaskRequestInput): Promise<Record<string, unknown>>;
  reviewChange(input: TaskRequestInput & { changeId: string; action: "accept" | "undo" }): Promise<Record<string, unknown>>;
  gitStatus(input: TaskRequestInput): Promise<GitStatusResult>;
  suggestCommitMessage(input: TaskRequestInput): Promise<{ message: string; generated: boolean }>;
  commitChanges(input: GitCommitInput): Promise<{ commit: string; branch: string | null; files: string[] }>;
  getModelSettings(): Promise<Record<string, unknown>>;
  saveModelSettings(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 真实请求一次模型；api 为 auto 时自动检测可用的接口类型。 */
  testModelSettings(input: Record<string, unknown>): Promise<ModelTestResult>;
  /** 向模型服务要模型列表（只含可以对话的模型）；不保存。 */
  listModels(input: Record<string, unknown>): Promise<string[]>;
  listMcpServers(): Promise<McpServer[]>;
  /** 保存整个列表；条目带 env 时替换环境变量，不带时沿用已保存的值。 */
  saveMcpServers(input: McpServer[]): Promise<McpServer[]>;
  testMcpServer(input: McpServer): Promise<{ ok: boolean; tools: string[]; message: string }>;
  getExecutionSettings(): Promise<ExecutionSettings>;
  saveExecutionSettings(input: ExecutionSettings): Promise<ExecutionSettings>;
  setTheme(theme: ColorTheme): void;
  selectWorkspace(): Promise<string | null>;
  setRepositoryWorkspace(workspaceRoot: string): Promise<string>;
  listRepositoryDirectory(input: RepositoryPathInput): Promise<RepositoryDirectoryResult>;
  readRepositoryFile(input: RepositoryPathInput): Promise<RepositoryFileResult>;
  health(gatewayUrl: string): Promise<unknown>;
  createTask(input: CreateTaskInput): Promise<Record<string, unknown>>;
  /** query 非空时按标题、要求和回答搜索。 */
  listSessions(gatewayUrl: string, offset?: number, query?: string): Promise<Record<string, unknown>>;
  renameSession(input: SessionRequestInput & { title: string }): Promise<Record<string, unknown>>;
  deleteSession(input: SessionRequestInput): Promise<Record<string, unknown>>;
  getSession(input: SessionRequestInput): Promise<Record<string, unknown>>;
  setSessionMode(input: SessionRequestInput & { mode: MultiAgentMode }): Promise<Record<string, unknown>>;
  listMemories(input: MemoryListInput): Promise<MemoryListResult>;
  deleteMemory(input: MemoryDeleteInput): Promise<Record<string, unknown>>;
  getTask(input: TaskRequestInput): Promise<Record<string, unknown>>;
  getResult(input: TaskRequestInput): Promise<Record<string, unknown>>;
  cancelTask(input: TaskRequestInput): Promise<Record<string, unknown>>;
  interactTask(input: TaskInteractionInput): Promise<Record<string, unknown>>;
  watchTask(input: TaskRequestInput): void;
  unwatchTask(taskId: string): void;
  onTaskEvent(listener: (event: TaskEvent) => void): () => void;
}
