import type { TaskEvent } from "../shared/contracts";

interface AgentResultLike {
  final_answer?: unknown;
  changed_files?: unknown;
  tests_passed?: unknown;
  quality_checks_passed?: unknown;
  acceptance_status?: unknown;
  rounds?: unknown;
  tool_calls?: unknown;
}

export interface ResultSummary {
  answer: string;
  changedFiles: string[];
  testsPassed: boolean | null;
  qualityPassed: boolean | null;
  acceptanceStatus: "NOT_RUN" | "PASSED" | "FAILED" | "NOT_VERIFIED";
  rounds: number | null;
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
  return {
    answer: typeof final.final_answer === "string" ? final.final_answer
      : typeof result?.error === "string" ? result.error
      : typeof envelope?.error === "string" ? envelope.error : "暂无最终回答",
    changedFiles: Array.isArray(final.changed_files)
      ? final.changed_files.filter((item): item is string => typeof item === "string")
      : [],
    testsPassed: directReply || noTests ? null : booleanOrNull(final.tests_passed),
    qualityPassed: directReply || noQuality ? null : booleanOrNull(final.quality_checks_passed),
    acceptanceStatus: !directReply && ["PASSED", "FAILED", "NOT_VERIFIED"].includes(String(final.acceptance_status))
      ? final.acceptance_status as ResultSummary["acceptanceStatus"] : "NOT_RUN",
    rounds: typeof final.rounds === "number" ? final.rounds : null,
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
    const target = typeof operation?.target === "string" ? operation.target : "";
    const finished = event.event_type === "TOOL_COMPLETED";
    const status = typeof payload.status === "string" ? payload.status.toUpperCase() : "";
    const succeeded = status === "SUCCESS";
    const actions = toolActions[toolName] ?? ["正在执行", "操作已完成", "操作失败"];
    const action = finished ? (succeeded ? actions[1] : actions[2]) : actions[0];
    return {
      key: `tool:${callId}`,
      title: `${action}${target ? ` ${shortTarget(target)}` : ""}`,
      tone: finished ? (succeeded ? "success" : "error") : "running",
      toolName,
      target,
      status: finished ? (succeeded ? "成功" : "失败") : "进行中",
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
