export const DEFAULT_MAX_TOOL_ROUNDS = 100;
export const MAX_TOOL_ROUNDS_LIMIT = 1000;

export interface ExecutionSettings {
  maxToolRounds: number;
}

export function parseExecutionSettings(input: unknown): ExecutionSettings {
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).maxToolRounds : undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TOOL_ROUNDS_LIMIT) {
    throw new Error(`最大交互轮数必须是 1–${MAX_TOOL_ROUNDS_LIMIT} 之间的整数`);
  }
  return { maxToolRounds: value };
}
