import type { DiagnosticService } from "@bit-agent/diagnostics";
import type { ColorTheme, RepositoryDirectoryResult, RepositoryFileResult } from "../../shared/contracts.js";
import type { ExecutionSettings } from "../../shared/execution-settings.js";

export interface GatewayClientPort {
  request(gatewayUrl: string, path: string, init?: RequestInit): Promise<Record<string, unknown>>;
}

export interface RepositoryAccessInput {
  workspaceRoot: string;
  path: string;
}

export interface RepositoryPort {
  validateRepositoryWorkspace(root: string): Promise<string>;
  listRepositoryDirectory(input: RepositoryAccessInput): Promise<RepositoryDirectoryResult>;
  readRepositoryFile(input: RepositoryAccessInput): Promise<RepositoryFileResult>;
}

export interface RuntimePort {
  managedHeaders(url: string): Record<string, string>;
  runtimeConfiguration(): { managed: boolean; gatewayUrl: string; startupError: string; version: string; userName: string };
  modelSettings(includeSecret?: boolean): Record<string, string | boolean>;
  saveModelSettings(input: unknown): Promise<Record<string, string | boolean>>;
  testModelSettings(input: unknown): Promise<Record<string, unknown>>;
  listProviderModels(input: unknown): Promise<string[]>;
  mcpServers(): Record<string, unknown>[];
  saveMcpServers(input: unknown): Promise<Record<string, unknown>[]>;
  testMcpServer(input: unknown): Promise<Record<string, unknown>>;
  /** 应用自带的 MCP 服务（例如内置浏览器），每次连同用户配置一起交给运行服务。 */
  setBuiltinMcpServers(servers: Record<string, unknown>[]): void;
  startManagedRuntime(): Promise<void>;
  stopManagedRuntime(): Promise<void>;
}

export interface PreferencesPort {
  loadTheme(): ColorTheme;
  saveTheme(theme: ColorTheme): void;
  /** 界面缩放倍数，1 为 100%。 */
  loadZoom(): number;
  saveZoom(zoom: number): void;
  readExecutionSettings(directory: string): ExecutionSettings;
  writeExecutionSettings(directory: string, input: unknown): ExecutionSettings;
}

/** 一个正在运行的伪终端。 */
export interface TerminalProcess {
  readonly shell: string;
  readonly cwd: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exitCode: number) => void): void;
}

export interface TerminalPort {
  /** cwd 为空时用用户目录。只启动系统 Shell。 */
  spawnTerminal(input: { cwd: string; cols: number; rows: number }): TerminalProcess;
}

/** Services assembled by main.ts. IPC knows these contracts, never their adapters. */
export interface DesktopServices extends RepositoryPort, RuntimePort, PreferencesPort, TerminalPort {
  gatewayClient: GatewayClientPort;
  diagnostics: DiagnosticService;
  saveDiagnosticBundle(snapshot?: unknown, unavailable?: boolean): Promise<
    { cancelled: boolean } | { path: string; files: number; diagnostic_id: string }
  >;
}
