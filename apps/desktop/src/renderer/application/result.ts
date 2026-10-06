import { isLocallyStopped } from "./stop";
import { object } from "../dom";
import {
estimateCost,formatTokens,summarizeResult,
usageDescription,type ResultSummary,type TokenPrices,type UsageSummary,
} from "../presentation";
import type { RendererApp } from "./context";

function resetMetrics(app: RendererApp): void {
  app.tests.textContent = "-";
  app.lint.textContent = "-";
  app.acceptance.textContent = "-";
  app.rounds.textContent = "-";
  delete app.tests.dataset.passed;
  delete app.lint.dataset.passed;
  delete app.acceptance.dataset.passed;
  app.verificationNotes.replaceChildren();
  app.verificationNotes.hidden = true;
  app.usageState.textContent = "-";
  app.usageCard.removeAttribute("title");
  app.files.textContent = "无文件修改";
  app.files.classList.add("empty-copy");
}

function showConversation(app: RendererApp, objective: string): void {
  app.emptyState.hidden = true;
  app.currentTurn.hidden = false;
  app.objectiveDisplay.textContent = objective;
}

function renderChangedFiles(app: RendererApp, changedFiles: string[]): void {
  app.files.replaceChildren();
  app.files.classList.toggle("empty-copy", changedFiles.length === 0);
  if (!changedFiles.length) {
    app.files.textContent = "无文件修改";
    return;
  }
  for (const path of changedFiles) {
    const item = document.createElement("div");
    item.className = "changed-file";
    const mark = document.createElement("span");
    mark.textContent = "M";
    const name = document.createElement("code");
    name.textContent = path;
    item.append(mark, name);
    app.files.append(item);
  }
}

function renderVerificationState(app: RendererApp, element: HTMLElement, passed: boolean | null): void {
  delete element.dataset.passed;
  if (passed === null) {
    element.textContent = "未运行";
    return;
  }
  element.textContent = passed ? "通过" : "未通过";
  element.dataset.passed = String(passed);
}

function finishResultStream(app: RendererApp, payload: Record<string, unknown>, summary: ResultSummary): string {
  const result = object(payload.result);
  const finalAnswer = typeof result?.final_answer === "string" && result.final_answer ? result.final_answer : null;
  const status = typeof payload.status === "string" ? payload.status : "";
  const failure = typeof payload.error === "string" ? payload.error
    : typeof result?.error === "string" ? result.error : null;
  app.showConversation(app.objectiveDisplay.textContent || app.activeObjective);
  app.streamView.finish({
    answer: isLocallyStopped(app) ? null : finalAnswer,
    cancelled: status === "CANCELLED" || isLocallyStopped(app),
    failure: finalAnswer ? null : failure ?? (status === "FAILED" ? summary.answer : null),
  });
  return status;
}

function renderResultVerification(app: RendererApp, summary: ResultSummary): void {
  app.renderVerificationState(app.tests, summary.testsPassed);
  app.renderVerificationState(app.lint, summary.qualityPassed);
  app.renderVerificationState(app.acceptance, summary.acceptanceStatus === "NOT_RUN" || summary.acceptanceStatus === "NOT_VERIFIED"
    ? null : summary.acceptanceStatus === "PASSED");
  if (summary.acceptanceStatus === "NOT_VERIFIED") app.acceptance.textContent = "未完成验证";
  if (summary.verificationStatus === "UNVERIFIED" || summary.verificationStatus === "NOT_APPLICABLE") {
    const unverified = summary.verificationStatus === "UNVERIFIED";
    for (const target of [app.tests, app.lint]) {
      target.textContent = unverified ? "无法验证" : "无需检查";
      if (unverified) target.dataset.passed = "unverified";
    }
  }
}

function renderVerificationNotes(app: RendererApp, summary: ResultSummary): void {
  app.verificationNotes.replaceChildren(...summary.verificationNotes.map((note) => {
    const item = document.createElement("li");
    item.textContent = note;
    return item;
  }));
  app.verificationNotes.dataset.kind = summary.verificationStatus === "UNVERIFIED" ? "unverified" : "info";
  app.verificationNotes.hidden = summary.verificationNotes.length === 0;
}

function renderResult(app: RendererApp, payload: Record<string, unknown>): void {
  const summary = summarizeResult(payload);
  const status = finishResultStream(app, payload, summary);
  app.renderChangedFiles(summary.changedFiles);
  renderResultVerification(app, summary);
  renderVerificationNotes(app, summary);
  app.rounds.textContent = summary.rounds === null ? "-" : String(summary.rounds);
  void app.renderUsage(summary.usage);
  app.errorActions.hidden = status !== "FAILED";
  app.updateActiveHistory({ finalAnswer: summary.answer });
}

async function renderUsage(app: RendererApp, usage: UsageSummary | null): Promise<void> {
  if (!usage) { app.usageState.textContent = "-"; app.usageCard.removeAttribute("title"); return; }
  // 部分服务流式输出时不返回用量，这时只显示请求次数，不显示误导的 0 / 0。
  const tokens = usage.inputTokens + usage.outputTokens > 0
    ? `${formatTokens(usage.inputTokens)} / ${formatTokens(usage.outputTokens)}`
    : `${usage.requests} 次请求`;
  app.usageState.textContent = tokens;
  app.usageCard.title = `${usageDescription(usage)}\n格式：输入 / 输出 tokens。`;
  // 填写过价格时附上估算费用；读取设置失败不影响用量显示。
  try {
    const settings = await window.bitAgent.getModelSettings();
    const cost = estimateCost(usage, app.tokenPrices(settings));
    if (cost && app.usageState.textContent === tokens) {
      app.usageState.textContent = `${tokens} · ≈${cost}`;
      app.usageCard.title += `\n估算费用 ${cost}，按模型设置里填写的价格计算，仅供参考。`;
    }
  } catch { /* 开发模式没有模型设置 */ }
}

function tokenPrices(app: RendererApp, settings: Record<string, unknown>): TokenPrices | null {
  const input = Number(settings.inputPrice);
  const output = Number(settings.outputPrice);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { input, output, currency: settings.currency === "$" ? "$" : "¥" };
}

async function loadResult(app: RendererApp): Promise<void> {
  if (!app.activeTaskId) return;
  const input = app.requestInput();
  const generation = app.viewGeneration;
  try {
    const task = await window.bitAgent.getTask(input);
    if (generation !== app.viewGeneration || input.taskId !== app.activeTaskId) return;
    app.interactionView?.update(task);
    const status = typeof task.status === "string" ? task.status : "UNKNOWN";
    app.setStatus(status);
    if (!app.terminalStatuses.has(status)) return;
    const payload = await window.bitAgent.getResult(input);
    if (generation !== app.viewGeneration || input.taskId !== app.activeTaskId) return;
    app.renderResult(payload);
    app.setBusy(false);
    app.sendQueued(isLocallyStopped(app) ? "CANCELLED" : status);
  } catch (error) {
    if (generation !== app.viewGeneration || input.taskId !== app.activeTaskId) return;
    app.showError(error);
  }
}

export function createResultController(app: RendererApp) {
  return {
    resetMetrics: resetMetrics.bind(null, app),
    showConversation: showConversation.bind(null, app),
    renderChangedFiles: renderChangedFiles.bind(null, app),
    renderVerificationState: renderVerificationState.bind(null, app),
    renderResult: renderResult.bind(null, app),
    renderUsage: renderUsage.bind(null, app),
    tokenPrices: tokenPrices.bind(null, app),
    loadResult: loadResult.bind(null, app),
  };
}
