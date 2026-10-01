import type { TaskEvent } from "../shared/contracts";

interface AgentResultLike {
  final_answer?: unknown;
  changed_files?: unknown;
  tests_passed?: unknown;
  quality_checks_passed?: unknown;
  acceptance_status?: unknown;
  verification_status?: unknown;
  verification_notes?: unknown;
  rounds?: unknown;
  tool_calls?: unknown;
}

/** UNVERIFIED：没有能运行的检查；NOT_APPLICABLE：只改了文档等不需要检查的文件。 */
export type VerificationStatus = "NOT_RUN" | "PASSED" | "FAILED" | "UNVERIFIED" | "NOT_APPLICABLE";
const verificationStatuses: VerificationStatus[] = ["NOT_RUN", "PASSED", "FAILED", "UNVERIFIED", "NOT_APPLICABLE"];

export interface UsageCounts { requests: number; inputTokens: number; outputTokens: number }
/** 整个任务的模型用量；byAgent 的键是 main、research、acceptance、auxiliary。 */
export interface UsageSummary extends UsageCounts { byAgent: Record<string, UsageCounts> }

export interface ResultSummary {
  answer: string;
  changedFiles: string[];
  testsPassed: boolean | null;
  qualityPassed: boolean | null;
  acceptanceStatus: "NOT_RUN" | "PASSED" | "FAILED" | "NOT_VERIFIED";
  verificationStatus: VerificationStatus;
  verificationNotes: string[];
  rounds: number | null;
  usage: UsageSummary | null;
}

function counts(value: unknown): UsageCounts | null {
  const record = object(value);
  const number = (key: string) => typeof record?.[key] === "number" && Number.isFinite(record[key]) ? record[key] as number : 0;
  return record ? { requests: number("requests"), inputTokens: number("input_tokens"), outputTokens: number("output_tokens") } : null;
}

function usageSummary(value: unknown): UsageSummary | null {
  const total = counts(value);
  if (!total || total.requests === 0) return null;
  const byAgent: Record<string, UsageCounts> = {};
  for (const [key, item] of Object.entries(object(object(value)?.by_agent) ?? {})) {
    const parsed = counts(item);
    if (parsed) byAgent[key] = parsed;
  }
  return { ...total, byAgent };
}

/** 950 → "950"，12345 → "12.3k"，1234567 → "1.23M"。 */
export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export interface TokenPrices { input: number; output: number; currency: string }

/** 按每百万 tokens 的价格估算费用；没有填写价格时返回 null。 */
export function estimateCost(usage: UsageCounts, prices: TokenPrices | null): string | null {
  if (!prices || (prices.input <= 0 && prices.output <= 0)) return null;
  const cost = (usage.inputTokens * prices.input + usage.outputTokens * prices.output) / 1_000_000;
  return `${prices.currency}${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

const agentLabels: Record<string, string> = {
  main: "主 Agent", research: "调查子 Agent", acceptance: "独立验收", auxiliary: "摘要等辅助请求",
};

export function usageDescription(usage: UsageSummary): string {
  const parts = Object.entries(usage.byAgent).map(([key, item]) =>
    `${agentLabels[key] ?? key}：${item.requests} 次，输入 ${item.inputTokens}，输出 ${item.outputTokens}`);
  return [`共 ${usage.requests} 次模型请求，输入 ${usage.inputTokens} tokens，输出 ${usage.outputTokens} tokens。`, ...parts]
    .join("\n") + (usage.requests > 0 && usage.inputTokens + usage.outputTokens === 0
    ? "\n模型服务没有返回 token 用量。" : "");
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function summarizeResult(payload: unknown): ResultSummary {
  const envelope = object(payload);
  const result = object(envelope?.result) ?? envelope;
  const final = (object(result?.final_agent_result) ?? result ?? {}) as AgentResultLike;
  const planning = object(result?.planning);
  const plan = object(planning?.plan);
  const directReply = plan?.route === "direct";
  const calls = Array.isArray(final.tool_calls) ? final.tool_calls.map(object) : null;
  const noTests = calls !== null && !calls.some(call => ["run_tests", "verify_project"].includes(String(call?.tool_name)));
  const noQuality = calls !== null && !calls.some(call => ["run_checks", "verify_project"].includes(String(call?.tool_name)));
  const verificationStatus = !directReply && verificationStatuses.includes(final.verification_status as VerificationStatus)
    ? final.verification_status as VerificationStatus : "NOT_RUN";
  // 没有能运行的检查时，测试和质量检查都不能显示成“未通过”或“通过”。
  const skipped = verificationStatus === "UNVERIFIED" || verificationStatus === "NOT_APPLICABLE";
  return {
    answer: typeof final.final_answer === "string" ? final.final_answer
      : typeof result?.error === "string" ? result.error
      : typeof envelope?.error === "string" ? envelope.error : "暂无最终回答",
    changedFiles: Array.isArray(final.changed_files)
      ? final.changed_files.filter((item): item is string => typeof item === "string")
      : [],
    testsPassed: directReply || noTests || skipped ? null : booleanOrNull(final.tests_passed),
    qualityPassed: directReply || noQuality || skipped ? null : booleanOrNull(final.quality_checks_passed),
    acceptanceStatus: !directReply && ["PASSED", "FAILED", "NOT_VERIFIED"].includes(String(final.acceptance_status))
      ? final.acceptance_status as ResultSummary["acceptanceStatus"] : "NOT_RUN",
    verificationStatus,
    verificationNotes: Array.isArray(final.verification_notes)
      ? final.verification_notes.filter((item): item is string => typeof item === "string") : [],
    rounds: typeof final.rounds === "number" ? final.rounds : null,
    usage: usageSummary(result?.task_usage),
  };
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export type ActivityTone = "running" | "success" | "error" | "neutral";

export interface ActivityPresentation {
  key: string;
  title: string;
  tone: ActivityTone;
  toolName?: string;
  target?: string;
  status?: string;
  durationMs?: number;
  errorCode?: string;
  remove?: boolean;
}

const toolActions: Record<string, [string, string, string]> = {
  list_files: ["正在查看", "已查看", "查看失败"],
  read_file: ["正在读取", "已读取", "读取失败"],
  search_code: ["正在搜索", "已搜索", "搜索失败"],
  run_tests: ["正在运行测试", "测试已完成", "测试失败"],
  run_checks: ["正在运行检查", "检查已完成", "检查失败"],
  apply_patch: ["正在修改", "已修改", "修改失败"],
  verify_project: ["正在运行基础检查", "基础检查通过", "基础检查未通过"],
  verify_task: ["正在独立验收", "独立验收通过", "独立验收未通过或未完成"],
  write_acceptance_test: ["正在编写验收测试", "验收测试已保存到隔离副本", "验收测试写入失败"],
  run_acceptance_test: ["正在运行验收测试", "验收测试已运行", "验收测试未通过"],
  submit_acceptance_report: ["正在提交验收报告", "验收报告已记录", "验收报告无效"],
  ask_user: ["正在等待你的选择", "已收到你的选择", "未收到有效选择"],
  delegate_tasks: ["正在启动调查", "调查已完成", "调查失败"],
};

function shortTarget(value: string): string {
  if (value.length <= 72 && !value.includes("/") && !value.includes("\\")) return value;
  const parts = value.split(/[\\/]/u);
  return parts.at(-1) || value.slice(0, 72);
}

export function isMainAgentText(data: Record<string, unknown> | null): boolean {
  const agent = data?.agent_id;
  return typeof agent !== "string" || (!agent.startsWith("research-") && !agent.startsWith("acceptance-"));
}

function eventPayload(event: TaskEvent): Record<string, unknown> {
  const data = object(event.data);
  return object(data?.payload) ?? data ?? {};
}

export function eventPresentation(event: TaskEvent): ActivityPresentation | null {
  const data = object(event.data);
  const payload = eventPayload(event);
  const agent = typeof data?.agent_id === "string" ? data.agent_id : "main";
  const round = typeof payload.round === "number" ? payload.round : 0;

  if (event.event_type === "MODEL_REQUESTED") {
    return { key: `model:${agent}:${round}`, title: "正在分析下一步", tone: "running" };
  }
  if (event.event_type === "MODEL_RESPONDED") {
    return { key: `model:${agent}:${round}`, title: "", tone: "neutral", remove: true };
  }

  if (event.event_type === "EXTERNAL_TOOLS_LOADED") {
    const list = (value: unknown) => Array.isArray(value) ? value.map(object).filter((item) => item !== null) : [];
    const connected = list(payload.connected).map((item) => `${String(item.name)}（${Number(item.tools) || 0} 个工具）`);
    const failed = list(payload.failed).map((item) => String(item.name));
    const parts = [connected.length ? `已连接外部工具 ${connected.join("、")}` : "",
      failed.length ? `外部工具连接失败：${failed.join("、")}` : ""].filter(Boolean);
    return { key: `external-tools:${event.id ?? ""}`, title: parts.join("；"), tone: failed.length ? "error" : "neutral" };
  }
  if (event.event_type === "PROJECT_INSTRUCTIONS_LOADED") {
    const paths = Array.isArray(payload.paths) ? payload.paths.filter(item => typeof item === "string") : [];
    return { key: `project-instructions:${event.id ?? ""}`, tone: "neutral",
      title: `已读取项目说明${paths.length ? ` ${paths.join("、")}` : ""}${payload.truncated ? "（内容较长，已截断）" : ""}` };
  }
  if (agent.startsWith("acceptance-") && ["AGENT_COMPLETED", "AGENT_FAILED"].includes(event.event_type)) {
    return {
      key: `tester:${agent}`, title: event.event_type === "AGENT_COMPLETED"
        ? "测试 Agent 已返回，正在核对验收报告" : "测试 Agent 执行未完成",
      tone: "neutral",
    };
  }
  if (event.event_type === "TOOL_REQUESTED" || event.event_type === "TOOL_COMPLETED") {
    const callId = String(payload.tool_call_id ?? event.id ?? `${agent}:${round}`);
    const toolName = String(payload.tool_name ?? "unknown");
    const operation = object(payload.operation);
    // 外部工具名形如 mcp__服务__工具，显示成“服务 · 工具”。
    const external = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/u.exec(toolName);
    const target = external ? `${external[1]} · ${external[2]}`
      : typeof operation?.target === "string" ? operation.target : "";
    const finished = event.event_type === "TOOL_COMPLETED";
    const status = typeof payload.status === "string" ? payload.status.toUpperCase() : "";
    const succeeded = status === "SUCCESS";
    // 没有能运行的检查不是失败，用中性提示，避免误以为代码出错。
    const unverified = finished && payload.error_code === "VERIFICATION_UNAVAILABLE";
    const actions = toolActions[toolName]
      ?? (external ? ["正在调用外部工具", "外部工具已返回", "外部工具调用失败"] : ["正在执行", "操作已完成", "操作失败"]);
    const action = unverified ? "无法自动验证" : finished ? (succeeded ? actions[1] : actions[2]) : actions[0];
    return {
      key: `tool:${callId}`,
      title: `${action}${target ? ` ${shortTarget(target)}` : ""}`,
      tone: unverified ? "neutral" : finished ? (succeeded ? "success" : "error") : "running",
      toolName,
      target,
      status: unverified ? "未验证" : finished ? (succeeded ? "成功" : "失败") : "进行中",
      ...(typeof payload.duration_ms === "number" ? { durationMs: payload.duration_ms } : {}),
      ...(typeof payload.error_code === "string" ? { errorCode: `${payload.error_code}${
        typeof payload.diagnostic_id === "string" ? ` · 诊断编号：${payload.diagnostic_id}` : ""}` } : {}),
    };
  }

  const simple: Record<string, [string, ActivityTone]> = {
    VERIFICATION_REQUIRED: ["修改完成，等待验证", "neutral"],
    AGENT_COMPLETED: ["任务已完成", "success"],
    AGENT_FAILED: ["任务执行失败", "error"],
    TASK_PAUSE_REQUESTED: ["正在暂停任务", "running"],
    TASK_PAUSED: ["任务已暂停", "neutral"],
    TASK_RESUMED: ["任务已继续", "running"],
    TASK_INTENT_UPDATED: ["已更新你的要求", "success"],
    USER_ANSWERED: ["已收到你的回答", "success"],
    QUESTION_DEFAULTED: ["等待超时，已采用推荐方案", "neutral"],
    desktop_error: ["桌面连接出现问题", "error"],
  };
  const item = simple[event.event_type];
  return item
    ? { key: `${event.event_type}:${event.id ?? round}`, title: item[0], tone: item[1] }
    : null;
}

export function eventTitle(event: TaskEvent): string {
  return eventPresentation(event)?.title ?? "";
}
