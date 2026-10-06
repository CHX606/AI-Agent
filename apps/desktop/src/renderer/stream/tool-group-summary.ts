import { mergePatchSummaries, type PatchSummary } from "./patch-summary";

export interface ToolRowSummary {
  tool: string;
  label: string;
  target: string;
  summary: string;
  tone: string;
  patch?: PatchSummary | undefined;
}

const readingTools = new Set(["list_files", "read_file", "search_code"]);
const phrases: Record<string, (count: number) => string> = {
  list_files: count => `查看了 ${count} 个目录`,
  read_file: count => `读取了 ${count} 个文件`,
  search_code: count => `搜索了 ${count} 次代码`,
  apply_patch: () => "修改文件",
  run_tests: count => `运行了 ${count} 次测试`,
  run_checks: count => `运行了 ${count} 次检查`,
  verify_project: count => `运行了 ${count} 次基础检查`,
  verify_task: count => `进行了 ${count} 次独立验收`,
  delegate_tasks: count => `进行了 ${count} 次调查`,
  ask_user: count => `进行了 ${count} 次询问`,
  write_acceptance_test: count => `编写了 ${count} 个验收测试`,
  run_acceptance_test: count => `运行了 ${count} 次验收测试`,
  submit_acceptance_report: count => `提交了 ${count} 次验收报告`,
};

/** 只合并查看类工具；其他操作按具体工具区分，外部服务的工具也各自保留。 */
export function toolGroupKind(tool: string): string {
  return readingTools.has(tool) ? "read" : tool;
}

function completedTitle(rows: ToolRowSummary[]): string {
  const first = rows[0];
  if (!first) return "";
  if (rows.length === 1 && !readingTools.has(first.tool)) return `${first.label}${first.target ? ` ${first.target}` : ""}`;
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.tool, (counts.get(row.tool) ?? 0) + 1);
  return [...counts].map(([tool, count]) => (phrases[tool]
    ?? (n => `${first.label}${first.target ? ` ${first.target}` : ""} ${n} 次`))(count)).join("，");
}

/** 收起后仍能看见结果；后续成功不能掩盖同组中已有的失败或未完成。 */
export function summarizeToolGroup(rows: ToolRowSummary[]) {
  const running = rows.find(row => row.tone === "running");
  const failures = rows.filter(row => row.tone === "error");
  const warnings = rows.filter(row => row.tone === "warning");
  const issue = failures.at(-1) ?? warnings.at(-1);
  const isPatch = rows.length > 0 && rows.every(row => row.tool === "apply_patch");
  const patch = isPatch ? mergePatchSummaries(rows.filter(row => row.tone === "success").map(row => row.patch)) : undefined;
  const text = running ? `${running.label}${running.target ? ` ${running.target}` : ""}…` : patch?.text ?? completedTitle(rows);
  const outcome = isPatch ? rows.findLast(row => row.tone === "neutral")?.summary ?? patch?.result ?? ""
    : rows.at(-1)?.summary ?? "";
  const result = running || rows.every(row => readingTools.has(row.tool)) ? "" : issue?.summary ?? outcome;
  const tone = running ? "running" : failures.length ? "error" : warnings.length ? "warning"
    : rows.every(row => row.tone === "success") ? "success" : "neutral";
  return { text, result, tone, failed: failures.length, warning: warnings.length,
    issues: [...failures, ...warnings].map(row => row.summary).filter(Boolean).join("\n") };
}
