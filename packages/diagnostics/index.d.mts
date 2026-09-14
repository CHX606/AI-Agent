import type { Logger } from "pino";
export type DiagnosticLevel = "info" | "warn" | "error" | "fatal";
export interface DiagnosticPort {
  record(level: DiagnosticLevel, event: string, fields?: Record<string, unknown>): void;
  failure(event: string, error: unknown, fields?: Record<string, unknown>): string;
}
export interface DiagnosticService extends DiagnosticPort {
  logger: Logger;
  directory: string;
  available(): boolean;
  flush(): Promise<void>;
  close(): Promise<void>;
}
export function createDiagnostics(options: { process: string; directory?: string; version?: string;
  maxBytes?: number; retentionDays?: number; maxFiles?: number }): DiagnosticService;
export function defaultLogDirectory(): string;
export function diagnosticId(error?: unknown): string;
export function publicError(id: string, message?: string): string;
export function safeFields(input: unknown): Record<string, unknown>;
export function redact(value: string): string;
export function registerSecret(value: string): void;
export function errorFields(error: unknown): Record<string, unknown>;
export function installProcessDiagnostics(service: DiagnosticPort): void;
export function exportDiagnostics(options: { directory: string; destination: string; version: string;
  snapshot?: unknown; unavailable?: boolean }): Promise<{ path: string; files: number; diagnostic_id: string }>;
