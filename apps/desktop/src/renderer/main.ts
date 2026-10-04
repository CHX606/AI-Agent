import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "@awesome.me/webawesome/dist/components/details/details.js";
import "./styles.css";

import type { ColorTheme, TaskEvent } from "../shared/contracts";
import { element, errorText, formatHistoryTime, object, projectName } from "./dom";
import {
  estimateCost, formatTokens, summarizeResult,
  usageDescription, type TokenPrices, type UsageSummary,
} from "./presentation";
import { createStreamView, type FileDiff, type StreamView } from "./stream-view";
import {
  clearPreviousTurns, getAgentMode, onAgentModeChange, type PreviousTurnOptions,
  renderPreviousTurns, setAgentMode, setModeDisabled,
} from "./session-view";

import { createInteractionView } from "./interaction-view";
import { mountModelMenu, type ModelMenu } from "./model-menu";
import { createRepositoryView } from "./repository-view";
import { loadHistory, saveHistory, type TaskHistoryEntry } from "./task-history";

const terminalStatuses = new Set(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]);
const statusLabels: Record<string, string> = {
  CANCELLATION_REQUESTED: "正在停止",
  CANCELLED: "已取消",
  COMPLETED: "已完成",
  ERROR: "出错",
  FAILED: "失败",
  IDLE: "就绪",
  PARTIAL: "部分完成",
  QUEUED: "排队中",
  RUNNING: "执行中",
  PAUSE_REQUESTED: "正在暂停",
  PAUSED: "已暂停",
  WAITING_FOR_INPUT: "等待回答",
  SUBMITTING: "正在提交",
  UNKNOWN: "状态未知",
};
const gatewayKey = "bit-agent.gateway-url.v1";
const workspaceKey = "bit-agent.workspace-root.v1";
const inspectorKey = "bit-agent.inspector-collapsed.v1";
import { mountProductControls, permissionMode } from "./product-controls";
const reportClientError = (kind: "exception" | "rejection", line?: number) => {
  void window.bitAgent.reportClientError({ kind, ...(line === undefined ? {} : { line }) })
    .then(message => { showError(new Error(message)); }).catch(() => {});
};
window.addEventListener("error", event => reportClientError("exception", event.lineno));
window.addEventListener("unhandledrejection", () => reportClientError("rejection"));
const initialTheme: ColorTheme = window.bitAgent.colorTheme;

document.documentElement.dataset.theme = initialTheme;
document.documentElement.classList.add("wa-theme-default");

const shell = element<HTMLElement>(".shell");
const gatewayInput = element<HTMLInputElement>("#gateway");
const workspaceInput = element<HTMLInputElement>("#workspace");
const workspaceName = element<HTMLElement>("#workspace-name");
const workspaceSummary = element<HTMLElement>("#workspace-summary");
const objectiveInput = element<HTMLTextAreaElement>("#objective");
const objectiveDisplay = element<HTMLElement>("#objective-display");
const runButton = element<HTMLButtonElement>("#run");
const retryButton = element<HTMLButtonElement>("#retry");
const newTaskButton = element<HTMLButtonElement>("#new-task");
const cancelButton = element<HTMLButtonElement>("#cancel");
const browseButton = element<HTMLButtonElement>("#browse");
const healthButton = element<HTMLButtonElement>("#health");
const statusText = element<HTMLElement>("#status");
const taskIdText = element<HTMLElement>("#task-id");
const currentTurn = element<HTMLElement>("#current-turn");
const files = element<HTMLElement>("#changed-files");
const tests = element<HTMLElement>("#tests-state");
const lint = element<HTMLElement>("#lint-state");
const acceptance = element<HTMLElement>("#acceptance-state");
const verificationNotes = element<HTMLUListElement>("#verification-notes");
const rounds = element<HTMLElement>("#rounds");
const usageState = element<HTMLElement>("#usage-state");
const usageCard = element<HTMLElement>("#usage-card");
const rawResult = element<HTMLElement>("#raw-result");
const connection = element<HTMLElement>("#connection");
const connectionDot = element<HTMLElement>("#connection-dot");
const taskHistory = element<HTMLElement>("#task-history");
const historyCount = element<HTMLElement>("#history-count");
const historyEmpty = element<HTMLElement>("#history-empty");
const emptyState = element<HTMLElement>("#empty-state");
const errorActions = element<HTMLElement>("#error-actions");
const inspectorToggle = element<HTMLButtonElement>("#inspector-toggle");
const inspectorClose = element<HTMLButtonElement>("#inspector-close");
const inspectorResize = element<HTMLElement>("#inspector-resize");
const themeToggle = element<HTMLButtonElement>("#theme-toggle");
const tasksNavigation = element<HTMLButtonElement>("#nav-tasks");
const repositoryNavigation = element<HTMLButtonElement>("#nav-repository");
const taskSidebarPane = element<HTMLElement>("#task-sidebar-pane");
const repositorySidebarPane = element<HTMLElement>("#repository-sidebar-pane");
const repositoryView = element<HTMLElement>("#repository-view");
const repository = createRepositoryView({
  currentWorkspace: () => workspaceInput.value.trim(),
  onBrowse: () => void browseWorkspace(),
});

let activeTaskId: string | null = null;
let activeSessionId: string | null = null;
let activeWorkspaceRoot = "";
let submitting = false;
let viewGeneration = 0;
let nextSessionOffset: number | null = 0;
let activeObjective = "";
/** 历史任务回放事件期间为 true；回放结束（desktop_stream_ended）后再载入最终结果。 */
let replaying = false;
let history = loadHistory();

/** 取某个任务里某次 apply_patch 写入的差异。 */
function diffLoader(taskId: () => string | null) {
  return async (callId: string): Promise<FileDiff[]> => {
    const id = taskId();
    if (!id) return [];
    const payload = await window.bitAgent.getChanges({ gatewayUrl: gatewayInput.value.trim(), taskId: id });
    const change = (Array.isArray(payload.changes) ? payload.changes : [])
      .map(object).find((item) => item?.call_id === callId);
    return (Array.isArray(change?.files) ? change.files : []).map(object)
      .filter((file): file is Record<string, unknown> => typeof file?.path === "string" && typeof file.diff === "string")
      .map((file) => ({ path: String(file.path), diff: String(file.diff) }));
  };
}

const conversationScroller = element<HTMLElement>("#conversation");
const streamView = createStreamView({
  stream: element<HTMLOListElement>("#stream"),
  statusLine: element<HTMLElement>("#status-line"),
  scroller: conversationScroller,
  loadDiff: diffLoader(() => activeTaskId),
});

/** 本次打开期间做过（或点开回放过）的轮次的过程节点，按任务 ID；继续对话时放回旧轮次。 */
const processCache = new Map<string, Node[]>();
/** 正在回放过程的旧轮次。 */
const processLoaders = new Map<string, { view: StreamView; answer: string; done(): void; fail(error: Error): void }>();

function keepProcess(taskId: string, nodes: Node[]): void {
  if (!nodes.length) return;
  processCache.delete(taskId);
  processCache.set(taskId, nodes);
  // 只留最近 20 轮，长对话不会无限占内存；更早的轮次仍可以点开回放。
  while (processCache.size > 20) processCache.delete(processCache.keys().next().value!);
}

function dropProcesses(): void {
  processCache.clear();
  for (const [taskId, loader] of processLoaders) {
    window.bitAgent.unwatchTask(taskId);
    loader.view.dispose();
    loader.fail(new Error("已切换对话"));
  }
  processLoaders.clear();
}

function previousTurnOptions(): PreviousTurnOptions {
  return {
    processes: processCache,
    expand: (taskId, stream, answer) => new Promise<void>((resolve, reject) => {
      // 先回放到一个新列表里，成功后再换上；失败时保留原来的回答。
      const replay = document.createElement("ol");
      replay.className = "stream";
      const view = createStreamView({
        stream: replay, scroller: conversationScroller, follow: false, loadDiff: diffLoader(() => taskId),
      });
      processLoaders.set(taskId, {
        view, answer, fail: reject,
        done: () => {
          stream.replaceChildren(...replay.childNodes);
          keepProcess(taskId, [...stream.childNodes]);
          resolve();
        },
      });
      window.bitAgent.watchTask({ gatewayUrl: gatewayInput.value.trim(), taskId });
    }),
  };
}

/** 旧轮次回放的事件交给对应的回放视图；返回 true 表示已处理。 */
function routeProcessEvent(event: TaskEvent): boolean {
  const loader = event.taskId ? processLoaders.get(event.taskId) : undefined;
  if (!loader || !event.taskId) return false;
  if (event.event_type === "desktop_stream_ended" || event.event_type === "desktop_error") {
    processLoaders.delete(event.taskId);
    window.bitAgent.unwatchTask(event.taskId);
    loader.view.dispose();
    if (event.event_type === "desktop_error") {
      loader.fail(new Error("回放失败"));
    } else {
      loader.view.finish({ answer: loader.answer || null, failure: null, cancelled: false });
      loader.done();
    }
  } else if (!event.event_type.startsWith("desktop_")) {
    loader.view.handle(event);
  }
  return true;
}
/** 搜索时显示的结果；为 null 时显示完整历史。 */
let searchResults: TaskHistoryEntry[] | null = null;
const sessionSearch = element<HTMLInputElement>("#session-search");
let activeView: "tasks" | "repository" = "tasks";
let interactionView: ReturnType<typeof createInteractionView> | null = null;
let modelMenu: ModelMenu | null = null;
let interactionRefreshSequence = 0;

function setTheme(theme: ColorTheme, syncWindow = true): void {
  const nextThemeLabel = theme === "dark" ? "浅色" : "暗色";
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("wa-dark", theme === "dark");
  document.documentElement.classList.toggle("wa-light", theme === "light");
  themeToggle.setAttribute("aria-label", `切换为${nextThemeLabel}主题`);
  themeToggle.title = `切换为${nextThemeLabel}主题`;
  if (syncWindow) window.bitAgent.setTheme(theme);
}

function setWorkspace(path: string): void {
  const workspaceRoot = path.trim();
  // 输入框触发 change 时已经是新值，需要与上次确认的目录比较。
  if (activeSessionId && workspaceRoot !== activeWorkspaceRoot) resetTask();
  activeWorkspaceRoot = workspaceRoot;
  workspaceInput.value = workspaceRoot;
  workspaceName.textContent = workspaceRoot ? projectName(workspaceRoot) : "尚未选择项目";
  workspaceSummary.textContent = workspaceRoot || "选择本地代码仓库";
  workspaceSummary.title = workspaceRoot;
  if (workspaceRoot) localStorage.setItem(workspaceKey, workspaceRoot);
  else localStorage.removeItem(workspaceKey);
  repository.setWorkspace(workspaceRoot, activeView === "repository");
}

function setActiveView(view: "tasks" | "repository"): void {
  activeView = view;
  shell.dataset.view = view;
  const showingTasks = view === "tasks";
  taskSidebarPane.hidden = !showingTasks;
  repositorySidebarPane.hidden = showingTasks;
  repositoryView.hidden = showingTasks;
  tasksNavigation.classList.toggle("is-active", showingTasks);
  repositoryNavigation.classList.toggle("is-active", !showingTasks);
  if (showingTasks) {
    tasksNavigation.setAttribute("aria-current", "page");
    repositoryNavigation.removeAttribute("aria-current");
  } else {
    repositoryNavigation.setAttribute("aria-current", "page");
    tasksNavigation.removeAttribute("aria-current");
    repository.activate();
  }
}

const renameIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/></svg>`;
const deleteIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>`;

function renderHistory(): void {
  taskHistory.replaceChildren();
  const visible = searchResults ?? history;
  historyCount.textContent = String(visible.length);
  historyEmpty.hidden = visible.length > 0;
  historyEmpty.textContent = searchResults ? "没有找到匹配的对话。" : "运行第一个任务后，会话会保存在这里。";

  for (const entry of visible) {
    const row = document.createElement("div");
    row.className = "history-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    button.disabled = submitting;
    button.dataset.active = String(entry.taskId === activeTaskId);
    button.title = entry.objective;

    const icon = document.createElement("span");
    icon.className = "history-status";
    icon.dataset.status = entry.status;
    icon.setAttribute("aria-hidden", "true");

    const copy = document.createElement("span");
    copy.className = "history-copy";
    const title = document.createElement("strong");
    title.textContent = entry.objective;
    const meta = document.createElement("span");
    meta.textContent = `${projectName(entry.workspaceRoot)} · ${formatHistoryTime(entry.createdAt)}`;
    copy.append(title, meta);
    button.append(icon, copy);
    button.addEventListener("click", () => void restoreTask(entry));

    const actions = document.createElement("div");
    actions.className = "history-actions";
    for (const [action, label, svg] of [["rename", "重命名", renameIcon], ["delete", "删除", deleteIcon]] as const) {
      const control = document.createElement("button");
      control.type = "button";
      control.dataset.action = action;
      control.title = label;
      control.setAttribute("aria-label", `${label}对话：${entry.objective}`);
      control.innerHTML = svg;
      control.disabled = submitting;
      control.addEventListener("click", (event) => {
        event.stopPropagation();
        if (action === "rename") startRename(entry, title);
        else void deleteConversation(entry);
      });
      actions.append(control);
    }
    row.append(button, actions);
    taskHistory.append(row);
  }
}

/** 在列表里直接改名：回车或失去焦点保存，Esc 放弃。 */
function startRename(entry: TaskHistoryEntry, title: HTMLElement): void {
  const input = document.createElement("input");
  input.className = "history-rename";
  input.value = entry.objective;
  input.maxLength = 100;
  input.setAttribute("aria-label", "新的对话名称");
  title.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (save: boolean): Promise<void> => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    if (!save || !name || name === entry.objective) { renderHistory(); return; }
    try {
      if (entry.sessionId) {
        await window.bitAgent.renameSession({ gatewayUrl: entry.gatewayUrl, sessionId: entry.sessionId, title: name });
      }
      history = history.map((item) => item.taskId === entry.taskId ? { ...item, objective: name } : item);
      searchResults = searchResults?.map((item) => item.taskId === entry.taskId ? { ...item, objective: name } : item) ?? null;
      saveHistory(history);
      if (entry.taskId === activeTaskId) taskIdText.textContent = name;
    } catch (error) {
      connection.textContent = `重命名失败：${errorText(error)}`;
    }
    renderHistory();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); void finish(true); }
    else if (event.key === "Escape") { event.preventDefault(); void finish(false); }
  });
  input.addEventListener("blur", () => void finish(true));
}

async function deleteConversation(entry: TaskHistoryEntry): Promise<void> {
  if (!window.confirm(`删除对话“${entry.objective}”？\n\n会删除这段对话的全部记录和改动快照，无法恢复。项目里的文件不受影响。`)) return;
  try {
    if (entry.sessionId) {
      await window.bitAgent.deleteSession({ gatewayUrl: entry.gatewayUrl, sessionId: entry.sessionId });
    }
  } catch (error) {
    connection.textContent = `删除失败：${errorText(error)}`;
    return;
  }
  const removed = (item: TaskHistoryEntry) => item.taskId === entry.taskId
    || (entry.sessionId !== undefined && item.sessionId === entry.sessionId && item.gatewayUrl === entry.gatewayUrl);
  history = history.filter((item) => !removed(item));
  searchResults = searchResults?.filter((item) => !removed(item)) ?? null;
  saveHistory(history);
  if ((entry.sessionId && entry.sessionId === activeSessionId) || entry.taskId === activeTaskId) resetTask();
  else renderHistory();
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSequence = 0;
/** 搜索标题、各轮要求和回答；没有会话编号的旧本地记录只按标题匹配。 */
async function searchSessions(query: string): Promise<void> {
  const sequence = ++searchSequence;
  if (!query) { searchResults = null; renderHistory(); return; }
  const gatewayUrl = gatewayInput.value.trim();
  const local = history.filter((entry) => !entry.sessionId && entry.objective.includes(query));
  try {
    const payload = await window.bitAgent.listSessions(gatewayUrl, 0, query);
    if (sequence !== searchSequence) return;
    searchResults = [...sessionEntries(payload, gatewayUrl), ...local];
  } catch {
    if (sequence !== searchSequence) return;
    searchResults = history.filter((entry) => entry.objective.includes(query));
  }
  renderHistory();
}

function upsertHistory(entry: TaskHistoryEntry): void {
  history = [entry, ...history.filter((item) => item.taskId !== entry.taskId
    && !(entry.sessionId && item.sessionId === entry.sessionId && item.gatewayUrl === entry.gatewayUrl))];
  saveHistory(history);
  renderHistory();
}

function updateActiveHistory(update: Partial<TaskHistoryEntry>): void {
  if (!activeTaskId) return;
  const current = history.find((item) => item.taskId === activeTaskId);
  if (!current) return;
  upsertHistory({ ...current, ...update });
}

function requestInput() {
  if (!activeTaskId) throw new Error("当前没有任务");
  return { gatewayUrl: gatewayInput.value.trim(), taskId: activeTaskId };
}

function setBusy(busy: boolean): void {
  const permission = document.querySelector<HTMLElement & { disabled: boolean }>("#permission-mode");
  if (permission) permission.disabled = busy;
  document.body.dataset.busy = String(busy);
  runButton.disabled = busy;
  retryButton.disabled = busy;
  newTaskButton.disabled = submitting;
  cancelButton.disabled = !busy;
  // 空闲时不显示红色的“停止”，只在有任务可停时出现。
  cancelButton.hidden = !busy;
  workspaceInput.disabled = busy;
  objectiveInput.disabled = busy;
  browseButton.disabled = busy;
  gatewayInput.disabled = busy;
  setModeDisabled(busy);
  modelMenu?.setDisabled(busy);
  for (const button of taskHistory.querySelectorAll<HTMLButtonElement>("button")) {
    button.disabled = submitting;
  }
  paintComposer();
}

const defaultPlaceholder = objectiveInput.placeholder;
const supplementStatuses = new Set(["QUEUED", "RUNNING", "PAUSE_REQUESTED", "PAUSED"]);

/**
 * 输入框此刻的用途，和 Claude Code 一样随任务状态变化：
 * new 新任务；supplement 运行中或暂停时补充要求；answer 回答 Agent 的问题或写下不批准的原因；
 * locked 正在提交或停止，暂不能输入。
 */
function composerMode(): "new" | "supplement" | "answer" | "locked" {
  if (document.body.dataset.busy !== "true") return "new";
  const status = statusText.dataset.status ?? "";
  if (replaying || !activeTaskId) return "locked";
  if (status === "WAITING_FOR_INPUT" && interactionView?.pendingKind()) return "answer";
  return supplementStatuses.has(status) ? "supplement" : "locked";
}

/** 输入框跟着内容长高，空的时候只有一行。 */
function fitComposer(): void {
  objectiveInput.style.height = "auto";
  const limit = Number.parseFloat(getComputedStyle(objectiveInput).maxHeight) || 220;
  objectiveInput.style.height = `${Math.min(objectiveInput.scrollHeight + 1, limit)}px`;
}
objectiveInput.addEventListener("input", fitComposer);

function paintComposer(): void {
  fitComposer();
  const mode = composerMode();
  const status = statusText.dataset.status;
  document.body.dataset.steering = mode === "answer" ? "WAITING_FOR_INPUT" : mode === "supplement" ? status ?? "" : "";
  if (document.body.dataset.busy === "true") {
    objectiveInput.disabled = mode === "locked";
    runButton.disabled = mode === "locked" || submitting;
  }
  const approval = interactionView?.pendingKind() === "approval";
  objectiveInput.placeholder = mode === "answer"
    ? approval ? "不批准？写下原因按 Enter，Agent 会按你的意见调整…" : "直接写下你的回答，按 Enter 提交…"
    : mode === "supplement"
      ? status === "PAUSED" ? "写下补充要求，按 Enter 提交并继续…" : "补充要求，Agent 会在下一步读取（Esc 暂停）…"
      : defaultPlaceholder;
}

function setStatus(status: string): void {
  statusText.textContent = statusLabels[status] ?? status;
  statusText.dataset.status = status;
  interactionView?.setStatus(status);
  // 回放历史事件时，事件里的旧状态只更新顶部标签，不驱动底部状态行。
  if (!replaying) streamView.setStatus(status);
  paintComposer();
  updateActiveHistory({ status });
}

function applyInteractionTask(task: Record<string, unknown>): void {
  if (task.task_id !== activeTaskId) return;
  interactionView?.update(task);
  const status = typeof task.status === "string" ? task.status : "UNKNOWN";
  setStatus(status);
  setBusy(!terminalStatuses.has(status));
  if (terminalStatuses.has(status) && !replaying) void loadResult();
}

async function refreshInteraction(): Promise<void> {
  if (!activeTaskId) return;
  const input = requestInput();
  const generation = viewGeneration;
  const sequence = ++interactionRefreshSequence;
  try {
    const task = await window.bitAgent.getTask(input);
    if (generation === viewGeneration && input.taskId === activeTaskId && sequence === interactionRefreshSequence) {
      applyInteractionTask(task);
    }
  } catch (error) {
    if (generation === viewGeneration && input.taskId === activeTaskId) {
      connection.textContent = `交互状态暂未同步：${errorText(error)}`;
    }
  }
}

function resetMetrics(): void {
  tests.textContent = "-";
  lint.textContent = "-";
  acceptance.textContent = "-";
  rounds.textContent = "-";
  delete tests.dataset.passed;
  delete lint.dataset.passed;
  delete acceptance.dataset.passed;
  verificationNotes.replaceChildren();
  verificationNotes.hidden = true;
  usageState.textContent = "-";
  usageCard.removeAttribute("title");
  files.textContent = "无文件修改";
  files.classList.add("empty-copy");
  rawResult.textContent = "等待任务完成…";
}

function showConversation(objective: string): void {
  emptyState.hidden = true;
  currentTurn.hidden = false;
  objectiveDisplay.textContent = objective;
}

function showError(error: unknown): void {
  replaying = false;
  currentTurn.hidden = false;
  emptyState.hidden = true;
  setStatus("ERROR");
  streamView.showError(errorText(error));
  errorActions.hidden = false;
  setBusy(false);
}

function appendEvent(event: TaskEvent): void {
  if (routeProcessEvent(event)) return;
  // 切换对话后，旧任务仍可在后台执行，但它的事件不能写进新对话。
  if (event.taskId && event.taskId !== activeTaskId) return;
  if (event.event_type === "desktop_stream_ended") {
    replaying = false;
    void loadResult();
    return;
  }

  if (event.event_type === "desktop_connection_state") {
    const state = object(event.data);
    const restartRequired = state?.restart_required === true;
    connection.textContent = state?.connected ? "已连接" : restartRequired
      ? "本地执行服务已退出，请重新启动应用后查看已保存的任务记录。"
      : "连接中断，正在自动重连；任务状态暂未同步";
    connection.dataset.connected = String(Boolean(state?.connected));
    connectionDot.dataset.connected = String(Boolean(state?.connected));
    if (restartRequired) {
      // 旧的状态请求不能覆盖已经确认的执行服务退出提示。
      viewGeneration += 1;
      statusText.textContent = "执行服务已退出";
      statusText.dataset.status = "ERROR";
      interactionView?.setStatus("ERROR");
      setBusy(true);
      cancelButton.disabled = true;
      errorActions.hidden = true;
    }
    if (state?.connected) void refreshInteraction();
    return;
  }
  const data = object(event.data);
  if (typeof data?.status === "string") setStatus(data.status);
  if (!replaying && ["TASK_PAUSE_REQUESTED", "TASK_PAUSED", "TASK_RESUMED", "TASK_INTENT_UPDATED",
    "USER_QUESTION", "USER_ANSWERED", "QUESTION_DEFAULTED"].includes(event.event_type)) {
    void refreshInteraction();
  }
  if (event.event_type === "desktop_error") { showError(data?.message ?? event.data); return; }
  streamView.handle(event);
}

function renderChangedFiles(changedFiles: string[]): void {
  files.replaceChildren();
  files.classList.toggle("empty-copy", changedFiles.length === 0);
  if (!changedFiles.length) {
    files.textContent = "无文件修改";
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
    files.append(item);
  }
}

function renderVerificationState(element: HTMLElement, passed: boolean | null): void {
  delete element.dataset.passed;
  if (passed === null) {
    element.textContent = "未运行";
    return;
  }
  element.textContent = passed ? "通过" : "未通过";
  element.dataset.passed = String(passed);
}

function renderResult(payload: Record<string, unknown>): void {
  const summary = summarizeResult(payload);
  const result = object(payload.result);
  const finalAnswer = typeof result?.final_answer === "string" && result.final_answer ? result.final_answer : null;
  const status = typeof payload.status === "string" ? payload.status : "";
  const failure = typeof payload.error === "string" ? payload.error
    : typeof result?.error === "string" ? result.error : null;
  showConversation(objectiveDisplay.textContent || activeObjective);
  streamView.finish({
    answer: finalAnswer,
    cancelled: status === "CANCELLED",
    failure: finalAnswer ? null : failure ?? (status === "FAILED" ? summary.answer : null),
  });
  renderChangedFiles(summary.changedFiles);
  renderVerificationState(tests, summary.testsPassed);
  renderVerificationState(lint, summary.qualityPassed);
  renderVerificationState(acceptance, summary.acceptanceStatus === "NOT_RUN" || summary.acceptanceStatus === "NOT_VERIFIED"
    ? null : summary.acceptanceStatus === "PASSED");
  if (summary.acceptanceStatus === "NOT_VERIFIED") acceptance.textContent = "未完成验证";
  if (summary.verificationStatus === "UNVERIFIED" || summary.verificationStatus === "NOT_APPLICABLE") {
    const unverified = summary.verificationStatus === "UNVERIFIED";
    for (const target of [tests, lint]) {
      target.textContent = unverified ? "无法验证" : "无需检查";
      if (unverified) target.dataset.passed = "unverified";
    }
  }
  verificationNotes.replaceChildren(...summary.verificationNotes.map((note) => {
    const item = document.createElement("li");
    item.textContent = note;
    return item;
  }));
  verificationNotes.dataset.kind = summary.verificationStatus === "UNVERIFIED" ? "unverified" : "info";
  verificationNotes.hidden = summary.verificationNotes.length === 0;
  rounds.textContent = summary.rounds === null ? "-" : String(summary.rounds);
  void renderUsage(summary.usage);
  rawResult.textContent = JSON.stringify(payload, null, 2);
  errorActions.hidden = status !== "FAILED";
  updateActiveHistory({ finalAnswer: summary.answer });
}

async function renderUsage(usage: UsageSummary | null): Promise<void> {
  if (!usage) { usageState.textContent = "-"; usageCard.removeAttribute("title"); return; }
  // 部分服务流式输出时不返回用量，这时只显示请求次数，不显示误导的 0 / 0。
  const tokens = usage.inputTokens + usage.outputTokens > 0
    ? `${formatTokens(usage.inputTokens)} / ${formatTokens(usage.outputTokens)}`
    : `${usage.requests} 次请求`;
  usageState.textContent = tokens;
  usageCard.title = `${usageDescription(usage)}\n格式：输入 / 输出 tokens。`;
  // 填写过价格时附上估算费用；读取设置失败不影响用量显示。
  try {
    const settings = await window.bitAgent.getModelSettings();
    const cost = estimateCost(usage, tokenPrices(settings));
    if (cost && usageState.textContent === tokens) {
      usageState.textContent = `${tokens} · ≈${cost}`;
      usageCard.title += `\n估算费用 ${cost}，按模型设置里填写的价格计算，仅供参考。`;
    }
  } catch { /* 开发模式没有模型设置 */ }
}

function tokenPrices(settings: Record<string, unknown>): TokenPrices | null {
  const input = Number(settings.inputPrice);
  const output = Number(settings.outputPrice);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { input, output, currency: settings.currency === "$" ? "$" : "¥" };
}

async function loadResult(): Promise<void> {
  if (!activeTaskId) return;
  const input = requestInput();
  const generation = viewGeneration;
  try {
    const task = await window.bitAgent.getTask(input);
    if (generation !== viewGeneration || input.taskId !== activeTaskId) return;
    interactionView?.update(task);
    const status = typeof task.status === "string" ? task.status : "UNKNOWN";
    setStatus(status);
    if (!terminalStatuses.has(status)) return;
    const payload = await window.bitAgent.getResult(input);
    if (generation !== viewGeneration || input.taskId !== activeTaskId) return;
    renderResult(payload);
    setBusy(false);
  } catch (error) {
    if (generation !== viewGeneration || input.taskId !== activeTaskId) return;
    showError(error);
  }
}

function sessionEntries(payload: Record<string, unknown>, gatewayUrl: string): TaskHistoryEntry[] {
  const loaded: TaskHistoryEntry[] = [];
  for (const raw of Array.isArray(payload.sessions) ? payload.sessions : []) {
    const session = object(raw);
    const task = object(session?.latest_task);
    if (typeof session?.session_id !== "string" || typeof task?.task_id !== "string") continue;
    loaded.push({
      taskId: task.task_id, sessionId: session.session_id,
      objective: String(session.title ?? task.objective ?? "对话"),
      workspaceRoot: String(session.workspace_root ?? ""), gatewayUrl,
      status: String(task.status ?? "UNKNOWN"), createdAt: String(session.updated_at ?? ""),
      multiAgentMode: session.multi_agent_mode === "on" || session.multi_agent_mode === "off"
        ? session.multi_agent_mode : "auto",
    });
  }
  return loaded;
}

async function refreshSessions(append = false): Promise<void> {
  const gatewayUrl = gatewayInput.value.trim();
  const offset = append ? nextSessionOffset : 0;
  if (offset === null) return;
  const payload = await window.bitAgent.listSessions(gatewayUrl, offset);
  if (gatewayUrl !== gatewayInput.value.trim()) return;
  nextSessionOffset = typeof payload.next_offset === "number" ? payload.next_offset : null;
  element<HTMLButtonElement>("#more-sessions").hidden = nextSessionOffset === null || searchResults !== null;
  if (!Array.isArray(payload.sessions)) return;
  const loaded = sessionEntries(payload, gatewayUrl);
  const identifiers = new Set(loaded.map((entry) => entry.sessionId));
  const remaining = history.filter((entry) => entry.gatewayUrl !== gatewayUrl || !identifiers.has(entry.sessionId));
  history = append ? [...remaining, ...loaded] : [...loaded, ...remaining];
  saveHistory(history);
  renderHistory();
}

function prepareRun(objective: string, title = objective): void {
  interactionView?.reset();
  replaying = false;
  activeObjective = objective;
  // 顶部显示对话名（和左侧列表一致），不是最新一句话。
  taskIdText.textContent = title;
  taskIdText.removeAttribute("title");
  errorActions.hidden = true;
  streamView.reset();
  showConversation(objective);
  resetMetrics();
  setBusy(true);
  setStatus("SUBMITTING");
}

/** 任务进行中的输入：补充要求（运行中排队、暂停时继续），或回答当前问题。 */
async function steer(mode: "supplement" | "answer"): Promise<void> {
  const text = objectiveInput.value.trim();
  if (!text || !interactionView || submitting) return;
  const approval = interactionView.pendingKind() === "approval";
  submitting = true;
  paintComposer();
  try {
    const sent = mode === "answer" ? await interactionView.answer(text) : await interactionView.supplement(text);
    if (sent) {
      objectiveInput.value = "";
      streamView.userNote(mode === "answer" && approval ? `不批准：${text}` : text);
    }
  } finally {
    submitting = false;
    paintComposer();
  }
}

async function runAgent(): Promise<void> {
  const composer = composerMode();
  if (composer === "supplement" || composer === "answer") { await steer(composer); return; }
  if (submitting || document.body.dataset.busy === "true") return;
  const objective = objectiveInput.value.trim();
  const workspaceRoot = workspaceInput.value.trim();
  if (objective) {
    activeObjective = objective;
    objectiveInput.value = "";
  }
  if (!objective || !workspaceRoot) {
    if (!workspaceRoot) setWorkspace("");
    showConversation(objective || "未填写任务目标");
    showError(new Error("请选择工作区并填写任务描述"));
    return;
  }

  const previousSession = activeSessionId;
  const mode = getAgentMode();
  if (activeTaskId) window.bitAgent.unwatchTask(activeTaskId);
  // 继续同一对话时，上一轮已经画好的过程原样留在页面上，不折叠成只剩回答。
  if (previousSession && activeTaskId) keepProcess(activeTaskId, streamView.detach());
  activeTaskId = null;
  const generation = ++viewGeneration;
  submitting = true;
  const title = previousSession
    ? history.find((item) => item.sessionId === previousSession && item.gatewayUrl === gatewayInput.value.trim())?.objective
    : undefined;
  prepareRun(objective, title ?? objective);
  try {
    if (previousSession) {
      const saved = await window.bitAgent.getSession({ gatewayUrl: gatewayInput.value.trim(), sessionId: previousSession });
      renderPreviousTurns(saved, null, previousTurnOptions());
      streamView.scrollToEnd();
    }
    const task = await window.bitAgent.createTask({
      gatewayUrl: gatewayInput.value.trim(),
      objective,
      workspaceRoot,
      ...(previousSession ? { sessionId: previousSession } : {}),
      multiAgentMode: mode,
      permissionMode: permissionMode(),
      ...(modelMenu?.selection() ?? {}),
    });
    if (generation !== viewGeneration) return;
    if (typeof task.task_id !== "string") throw new Error("Gateway 没有返回 task_id");
    activeTaskId = task.task_id;
    activeSessionId = typeof task.session_id === "string" ? task.session_id : null;
    interactionView?.update(task);
    taskIdText.title = `任务 ID：${activeTaskId}`;
    const status = typeof task.status === "string" ? task.status : "QUEUED";
    // 继续已有对话时保留它的标题（可能是用户改过的名字），不用最新一句话覆盖。
    const existing = previousSession
      ? history.find((item) => item.sessionId === previousSession && item.gatewayUrl === gatewayInput.value.trim())
      : undefined;
    upsertHistory({
      taskId: activeTaskId,
      objective: existing?.objective ?? objective,
      workspaceRoot,
      gatewayUrl: gatewayInput.value.trim(),
      status,
      createdAt: new Date().toISOString(),
      ...(activeSessionId ? { sessionId: activeSessionId } : {}),
      multiAgentMode: mode,
      permissionMode: permissionMode(),
    });
    setStatus(status);
    window.bitAgent.watchTask(requestInput());
  } catch (error) {
    showError(error);
    objectiveInput.value = objective;
  } finally {
    submitting = false;
    setBusy(document.body.dataset.busy === "true");
  }
}

async function restoreTask(entry: TaskHistoryEntry): Promise<void> {
  if (submitting || entry.taskId === activeTaskId) return;
  if (activeTaskId) window.bitAgent.unwatchTask(activeTaskId);
  const generation = ++viewGeneration;
  activeSessionId = null;
  setWorkspace(entry.workspaceRoot);
  activeTaskId = entry.taskId;
  activeSessionId = entry.sessionId ?? null;
  activeObjective = entry.objective;
  gatewayInput.value = entry.gatewayUrl;
  objectiveInput.value = "";
  setAgentMode(entry.multiAgentMode);
  dropProcesses();
  clearPreviousTurns();
  interactionView?.reset();
  setBusy(true);
  taskIdText.textContent = entry.objective;
  taskIdText.title = `任务 ID：${entry.taskId}`;
  errorActions.hidden = true;
  replaying = false;
  streamView.reset();
  streamView.setLoading("正在载入记录…");
  showConversation(entry.objective);
  setStatus(entry.status);
  renderHistory();

  try {
    const input = { gatewayUrl: entry.gatewayUrl, taskId: entry.taskId };
    if (entry.sessionId) {
      const saved = await window.bitAgent.getSession({ gatewayUrl: entry.gatewayUrl, sessionId: entry.sessionId });
      if (generation !== viewGeneration) return;
      renderPreviousTurns(saved, entry.taskId, previousTurnOptions());
      streamView.scrollToEnd();
      setAgentMode(object(saved.session)?.multi_agent_mode);
    }
    const task = await window.bitAgent.getTask(input);
    if (generation !== viewGeneration) return;
    if (typeof task.objective === "string") {
      activeObjective = task.objective;
      objectiveDisplay.textContent = task.objective;
    }
    interactionView?.update(task);
    const status = typeof task.status === "string" ? task.status : entry.status;
    streamView.setStartedAt(typeof task.started_at === "string" ? task.started_at : null);
    if (terminalStatuses.has(status)) {
      // 已结束的任务：回放保存的事件，重建完整的过程；回放结束后再载入最终结果。
      replaying = true;
      setStatus(status);
      window.bitAgent.watchTask(requestInput());
    } else {
      streamView.setLoading(null);
      setStatus(status);
      setBusy(true);
      window.bitAgent.watchTask(requestInput());
    }
  } catch (error) {
    if (generation !== viewGeneration) return;
    showError(error);
  }
}

function resetTask(): void {
  if (submitting) return;
  viewGeneration += 1;
  interactionView?.reset();
  if (activeTaskId) window.bitAgent.unwatchTask(activeTaskId);
  activeTaskId = null;
  activeSessionId = null;
  setAgentMode("auto");
  dropProcesses();
  clearPreviousTurns();
  activeObjective = "";
  replaying = false;
  taskIdText.textContent = "新任务";
  taskIdText.removeAttribute("title");
  setStatus("IDLE");
  streamView.reset();
  emptyState.hidden = false;
  currentTurn.hidden = true;
  errorActions.hidden = true;
  objectiveInput.value = "";
  resetMetrics();
  setBusy(false);
  renderHistory();
  objectiveInput.focus();
}

function setInspectorCollapsed(collapsed: boolean): void {
  shell.dataset.inspectorCollapsed = String(collapsed);
  inspectorToggle.setAttribute("aria-expanded", String(!collapsed));
  localStorage.setItem(inspectorKey, String(collapsed));
}

async function browseWorkspace(): Promise<void> {
  const path = await window.bitAgent.selectWorkspace();
  if (path) setWorkspace(path);
}

browseButton.addEventListener("click", () => void browseWorkspace());
tasksNavigation.addEventListener("click", () => setActiveView("tasks"));
repositoryNavigation.addEventListener("click", () => setActiveView("repository"));

workspaceInput.addEventListener("change", () => setWorkspace(workspaceInput.value.trim()));
gatewayInput.addEventListener("change", () => {
  localStorage.setItem(gatewayKey, gatewayInput.value.trim());
});

healthButton.addEventListener("click", async () => {
  connection.textContent = "连接中…";
  connection.dataset.connected = "pending";
  connectionDot.dataset.connected = "pending";
  try {
    await window.bitAgent.health(gatewayInput.value.trim());
    connection.textContent = "Gateway 已连接";
    connection.dataset.connected = "true";
    connectionDot.dataset.connected = "true";
    try {
      await refreshSessions();
    } catch (error) {
      connection.textContent = `Gateway 已连接，但本地会话列表不可用：${errorText(error)}`;
    }
  } catch (error) {
    connection.textContent = errorText(error, "连接失败");
    connection.dataset.connected = "false";
    connectionDot.dataset.connected = "false";
  }
});

runButton.addEventListener("click", () => void runAgent());
retryButton.addEventListener("click", () => {
  objectiveInput.value = activeObjective || objectiveInput.value;
  void runAgent();
});
newTaskButton.addEventListener("click", resetTask);

const permissionOrder = ["confirm", "edit", "read_only"] as const;
/** Shift+Tab 依次切换本轮工具权限，和 Claude Code 切换模式的方式一致。 */
function cyclePermission(): void {
  const select = document.querySelector<HTMLElement & { value: string; disabled: boolean }>("#permission-mode");
  if (!select || select.disabled) return;
  const index = permissionOrder.indexOf(select.value as typeof permissionOrder[number]);
  select.value = permissionOrder[(index + 1) % permissionOrder.length]!;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

objectiveInput.addEventListener("keydown", (event) => {
  // 输入法组字时的回车只是确认候选词，不能发送。
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!runButton.disabled) void runAgent();
  } else if (event.key === "Tab" && event.shiftKey) {
    event.preventDefault();
    cyclePermission();
  }
});

// Esc 暂停：在安全位置停下，之后可以补充要求或继续（和 Claude Code 中断后再输入的体验一致）。
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
  const pause = document.querySelector<HTMLButtonElement>("#pause-task");
  if (pause && !pause.hidden && !pause.disabled) {
    event.preventDefault();
    pause.click();
  }
});

cancelButton.addEventListener("click", async () => {
  try {
    cancelButton.disabled = true;
    const task = await window.bitAgent.cancelTask(requestInput());
    setStatus(typeof task.status === "string" ? task.status : "CANCELLATION_REQUESTED");
  } catch (error) {
    showError(error);
  }
});

inspectorToggle.addEventListener("click", () => {
  setInspectorCollapsed(shell.dataset.inspectorCollapsed !== "true");
});
inspectorClose.addEventListener("click", () => setInspectorCollapsed(true));
themeToggle.addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

let resizingInspector = false;
inspectorResize.addEventListener("pointerdown", (event) => {
  if (window.innerWidth <= 900) return;
  resizingInspector = true;
  inspectorResize.setPointerCapture(event.pointerId);
  document.body.dataset.resizing = "true";
});
window.addEventListener("pointermove", (event) => {
  if (!resizingInspector) return;
  const width = Math.min(520, Math.max(280, window.innerWidth - event.clientX));
  document.documentElement.style.setProperty("--inspector-width", `${width}px`);
});
window.addEventListener("pointerup", () => {
  resizingInspector = false;
  delete document.body.dataset.resizing;
});

interactionView = createInteractionView({ current: requestInput, apply: applyInteractionTask });
mountProductControls(requestInput, () => ({ gatewayUrl: gatewayInput.value.trim(),
  ...(activeTaskId ? { taskId: activeTaskId } : {}) }),
() => ({ gatewayUrl: gatewayInput.value.trim(), workspaceRoot: workspaceInput.value.trim() }));
modelMenu = mountModelMenu(element<HTMLElement>(".composer-actions"), () => element<HTMLButtonElement>("#model-settings").click());
modelMenu.setDisabled(document.body.dataset.busy === "true");
window.bitAgent.onTaskEvent(appendEvent);

onAgentModeChange((mode) => {
  updateActiveHistory({ multiAgentMode: mode });
  if (!activeSessionId) return;
  void window.bitAgent.setSessionMode({
    gatewayUrl: gatewayInput.value.trim(), sessionId: activeSessionId, mode,
  }).catch((error: unknown) => {
    connection.textContent = `模式尚未保存：${errorText(error)}`;
  });
});

sessionSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const query = sessionSearch.value.trim();
  element<HTMLButtonElement>("#more-sessions").hidden = query !== "" || nextSessionOffset === null;
  searchTimer = setTimeout(() => void searchSessions(query), query ? 250 : 0);
});

element<HTMLButtonElement>("#more-sessions").addEventListener("click", () => {
  void refreshSessions(true).catch((error: unknown) => {
    connection.textContent = errorText(error);
  });
});

gatewayInput.value = window.bitAgent.runtimeConfig.managed
  ? window.bitAgent.runtimeConfig.gatewayUrl : localStorage.getItem(gatewayKey) ?? gatewayInput.value;
if (window.bitAgent.runtimeConfig.managed) {
  history = history.map((entry) => ({ ...entry, gatewayUrl: gatewayInput.value }));
  gatewayInput.readOnly = true;
}
setWorkspace(localStorage.getItem(workspaceKey) ?? "");
setInspectorCollapsed(localStorage.getItem(inspectorKey) === "true");
setTheme(initialTheme, false);
setActiveView("tasks");
renderHistory();
resetMetrics();
void healthButton.click();
