export const DEFAULT_MAX_TOOL_ROUNDS = 100;
export const MAX_TOOL_ROUNDS_LIMIT = 1000;

/** 独立验收：自动按改动大小决定，总是每次都做，关闭只做基础检查。 */
export type AcceptanceMode = "auto" | "always" | "off";
export const DEFAULT_ACCEPTANCE_MODE: AcceptanceMode = "auto";
const acceptanceModes: readonly AcceptanceMode[] = ["auto", "always", "off"];

export interface ExecutionSettings {
  maxToolRounds: number;
  acceptanceMode: AcceptanceMode;
}

export function defaultExecutionSettings(): ExecutionSettings {
  return { maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS, acceptanceMode: DEFAULT_ACCEPTANCE_MODE };
}

export function parseExecutionSettings(input: unknown): ExecutionSettings {
  const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const value = record.maxToolRounds;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TOOL_ROUNDS_LIMIT) {
    throw new Error(`最大交互轮数必须是 1–${MAX_TOOL_ROUNDS_LIMIT} 之间的整数`);
  }
  // 旧版本保存的设置没有这一项，按默认的“自动”处理。
  const mode = record.acceptanceMode ?? DEFAULT_ACCEPTANCE_MODE;
  if (!acceptanceModes.includes(mode as AcceptanceMode)) throw new Error("独立验收设置无效");
  return { maxToolRounds: value, acceptanceMode: mode as AcceptanceMode };
}
