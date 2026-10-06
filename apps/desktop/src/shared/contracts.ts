import type { ExecutionSettings } from "./execution-settings.js";
import type { ImageAttachment } from "./image-input.js";

export interface CreateTaskInput {
  gatewayUrl: string;
  objective: string;
  images?: ImageAttachment[];
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
  images?: ImageAttachment[];
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

/**
 * 外部工具（MCP Server）。env（stdio）和 headers（http）只在新填写时出现；
 * 已保存的只给出名字 envKeys / headerKeys。
 */
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
  headerKeys?: string[];
  headers?: Record<string, string>;
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

/** 内置终端。workspaceRoot 为空时在用户目录打开。 */
export interface TerminalOpenInput {
  workspaceRoot: string;
  cols: number;
  rows: number;
}

export interface TerminalInfo {
  id: string;
  shell: string;
  cwd: string;
}

export interface TerminalOutput {
  id: string;
  data: string;
}

export interface TerminalExit {
  id: string;
  exitCode: number;
}

/** 内置浏览器在窗口里的位置（CSS 像素，相对窗口内容区）。 */
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserTab {
  id: string;
  title: string;
  /** 空字符串表示新标签页（显示起始页）。 */
  url: string;
  loading: boolean;
  favicon: string | null;
  /** Agent 正在使用的标签页。 */
  agent?: boolean;
}

/** 整个浏览器的状态；url 等字段描述当前标签页。 */
export interface BrowserState {
  tabs: BrowserTab[];
  activeId: string | null;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** 缩放比例，1 为 100%。 */
  zoom: number;
  /** 加载失败时的说明；成功加载后清空。certificate 为 true 时可以选择继续访问。 */
  error: { code: number; description: string; url: string; certificate?: boolean } | null;
  /** 网页进入了 HTML 全屏（例如视频全屏），这时视图铺满整个窗口。 */
  fullscreen: boolean;
}

/** 网页向用户提出的请求：权限或登录。 */
export type BrowserPrompt =
  | { id: string; kind: "permission"; origin: string; permission: string; label: string }
  | { id: string; kind: "login"; origin: string; realm: string; proxy: boolean };

export type BrowserPromptAnswer = { allow: boolean } | { username: string; password: string } | { cancel: true };

export interface BrowserDownload {
  id: string;
  filename: string;
  path: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  received: number;
  total: number;
  /** 可执行文件（.exe、.bat 等）只提供“在文件夹中显示”，不直接打开。 */
  executable: boolean;
}

export type BrowserAction = "back" | "forward" | "reload" | "stop" | "devtools" | "external"
  | "zoom-in" | "zoom-out" | "zoom-reset" | "print";

/** 浏览器页面里按下、需要交给应用处理的快捷键。 */
export type BrowserShortcut = "focus-address" | "toggle-sidebar" | "toggle-terminal" | "find"
  | "new-tab" | "close-tab" | "next-tab" | "previous-tab" | "bookmark";

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
  /** 回到最后一轮开始前；返回 objective、images 和被撤销的文件。 */
  rewindTurn(input: SessionRequestInput & { taskId: string }): Promise<Record<string, unknown>>;
  /** 由主进程写入系统剪贴板；窗口没有焦点时也能复制。 */
  copyText(text: string): Promise<void>;
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
  /** 在主进程启动一个 PowerShell；只能启动系统 Shell，不能指定任意命令。 */
  openTerminal(input: TerminalOpenInput): Promise<TerminalInfo>;
  writeTerminal(id: string, data: string): void;
  resizeTerminal(id: string, cols: number, rows: number): void;
  closeTerminal(id: string): Promise<void>;
  onTerminalOutput(listener: (output: TerminalOutput) => void): () => void;
  onTerminalExit(listener: (exit: TerminalExit) => void): () => void;
  /** 主进程里浏览器的当前状态（页面重新加载后用来接上已有的标签页）。 */
  getBrowserState(): Promise<BrowserState>;
  /** 显示内置浏览器并放到 bounds 位置；url 为空时只显示，不导航。 */
  showBrowser(bounds: BrowserBounds, url?: string): Promise<BrowserState>;
  setBrowserBounds(bounds: BrowserBounds): void;
  /** 隐藏浏览器（页面保留）。snapshot 为 true 时先返回当前画面，供弹窗遮挡时显示。 */
  hideBrowser(snapshot?: boolean): Promise<string | null>;
  /** 在当前标签页打开；没有标签页时新建一个。 */
  navigateBrowser(url: string): Promise<void>;
  /** 新建标签页并切换过去；url 为空时显示起始页。lazy 为 true 时先不加载，切换过去时再加载（恢复标签页用）。 */
  newBrowserTab(url?: string, options?: { activate?: boolean; lazy?: boolean; title?: string }): Promise<string>;
  closeBrowserTab(id: string): Promise<void>;
  selectBrowserTab(id: string): Promise<void>;
  browserAction(action: BrowserAction): Promise<void>;
  downloadAction(id: string, action: "open" | "show" | "cancel"): Promise<void>;
  /** 回答网页的权限或登录请求。 */
  answerBrowserPrompt(id: string, answer: BrowserPromptAnswer): Promise<void>;
  onBrowserPrompt(listener: (prompt: BrowserPrompt | { id: string; kind: "dismiss" }) => void): () => void;
  /** 当前标签页证书有问题时，用户确认继续访问（只信任这一张证书，直到应用退出）。 */
  trustBrowserCertificate(): Promise<void>;
  onBrowserDownload(listener: (download: BrowserDownload) => void): () => void;
  findInBrowser(text: string, options?: { forward?: boolean; next?: boolean }): Promise<{ matches: number; active: number }>;
  stopFindInBrowser(): void;
  /** 探测本机常见端口上正在运行的开发服务器。 */
  detectLocalServers(): Promise<number[]>;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  /** Agent 开始使用浏览器时，要求页面打开浏览器面板。 */
  onBrowserReveal(listener: () => void): () => void;
  onBrowserShortcut(listener: (shortcut: BrowserShortcut) => void): () => void;
}
