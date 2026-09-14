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
  runtimeConfiguration(): { managed: boolean; gatewayUrl: string; startupError: string };
  modelSettings(includeSecret?: boolean): Record<string, string | boolean>;
  saveModelSettings(input: unknown): Promise<Record<string, string | boolean>>;
  startManagedRuntime(): Promise<void>;
  stopManagedRuntime(): Promise<void>;
}

export interface PreferencesPort {
  loadTheme(): ColorTheme;
  saveTheme(theme: ColorTheme): void;
  readExecutionSettings(directory: string): ExecutionSettings;
  writeExecutionSettings(directory: string, input: unknown): ExecutionSettings;
}

/** Services assembled by main.ts. IPC knows these contracts, never their adapters. */
export interface DesktopServices extends RepositoryPort, RuntimePort, PreferencesPort {
  gatewayClient: GatewayClientPort;
  diagnostics: DiagnosticService;
  saveDiagnosticBundle(snapshot?: unknown, unavailable?: boolean): Promise<
    { cancelled: boolean } | { path: string; files: number; diagnostic_id: string }
  >;
}
