import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "@awesome.me/webawesome/dist/components/details/details.js";
import "./styles.css";

import type {
  ColorTheme,
  MultiAgentMode,
  RepositoryDirectoryResult,
  RepositoryEntry,
  TaskEvent,
} from "../shared/contracts";
import { renderMarkdown } from "./markdown";
import { eventPresentation, isMainAgentText, summarizeResult } from "./presentation";
import {
  clearPreviousTurns, getAgentMode, onAgentModeChange,
  renderPreviousTurns, setAgentMode, setModeDisabled,
} from "./session-view";

import { createInteractionView } from "./interaction-view";

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
const historyKey = "bit-agent.task-history.v1";
const gatewayKey = "bit-agent.gateway-url.v1";
const workspaceKey = "bit-agent.workspace-root.v1";
const inspectorKey = "bit-agent.inspector-collapsed.v1";
const maximumHistoryEntries = 200;
import { mountProductControls, permissionMode } from "./product-controls";
const reportClientError = (kind: "exception" | "rejection", line?: number) => {
  void window.bitAgent.reportClientError({ kind, ...(line === undefined ? {} : { line }) })
    .then(message => { showError(new Error(message)); }).catch(() => {});
};
window.addEventListener("error", event => reportClientError("exception", event.lineno));
window.addEventListener("unhandledrejection", () => reportClientError("rejection"));
let streamingText = "";
let streamingIdentity = "";
const initialTheme: ColorTheme = window.bitAgent.colorTheme;

document.documentElement.dataset.theme = initialTheme;
document.documentElement.classList.add("wa-theme-default");

interface TaskHistoryEntry {
  permissionMode?: "read_only" | "confirm" | "edit";
  taskId: string;
  objective: string;
  workspaceRoot: string;
  gatewayUrl: string;
  status: string;
  createdAt: string;
  finalAnswer?: string;
  sessionId?: string;
  multiAgentMode?: MultiAgentMode;
}

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`缺少界面元素：${selector}`);
  return found;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

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
const timeline = element<HTMLOListElement>("#timeline");
const activityCount = element<HTMLElement>("#activity-count");
const activityEmpty = element<HTMLElement>("#activity-empty");
const answer = element<HTMLElement>("#answer");
const files = element<HTMLElement>("#changed-files");
const tests = element<HTMLElement>("#tests-state");
const lint = element<HTMLElement>("#lint-state");
const acceptance = element<HTMLElement>("#acceptance-state");
const rounds = element<HTMLElement>("#rounds");
const rawResult = element<HTMLElement>("#raw-result");
const connection = element<HTMLElement>("#connection");
const connectionDot = element<HTMLElement>("#connection-dot");
const taskHistory = element<HTMLElement>("#task-history");
const historyCount = element<HTMLElement>("#history-count");
const historyEmpty = element<HTMLElement>("#history-empty");
const emptyState = element<HTMLElement>("#empty-state");
const userMessage = element<HTMLElement>("#user-message");
const activityMessage = element<HTMLElement>("#activity-message");
const assistantMessage = element<HTMLElement>("#assistant-message");
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
const repositoryRootLabel = element<HTMLElement>("#repository-root-label");
const repositoryRefresh = element<HTMLButtonElement>("#repository-refresh");
const repositoryBrowse = element<HTMLButtonElement>("#repository-browse");
const repositoryTree = element<HTMLElement>("#repository-tree");
const repositoryTreeState = element<HTMLElement>("#repository-tree-state");
const repositoryTreeMessage = element<HTMLElement>("#repository-tree-message");
const repositoryEntryCount = element<HTMLElement>("#repository-entry-count");
const repositoryFileTitle = element<HTMLElement>("#repository-file-title");
const repositoryFileMeta = element<HTMLElement>("#repository-file-meta");
const repositoryPreviewEmpty = element<HTMLElement>("#repository-preview-empty");
const repositoryPreviewContent = element<HTMLElement>("#repository-preview-content");
const repositoryPreviewNotice = element<HTMLElement>("#repository-preview-notice");
const repositoryFileContent = element<HTMLElement>("#repository-file-content");

let activeTaskId: string | null = null;
let activeSessionId: string | null = null;
let activeWorkspaceRoot = "";
let submitting = false;
let viewGeneration = 0;
let nextSessionOffset: number | null = 0;
let activeObjective = "";
let eventCount = 0;
const activityCards = new Map<string, HTMLLIElement>();
let history = loadHistory();
let activeView: "tasks" | "repository" = "tasks";
let repositoryLoadGeneration = 0;
let repositoryPreviewGeneration = 0;
let repositoryLoadedRoot = "";
let selectedRepositoryEntry: HTMLButtonElement | null = null;
let interactionView: ReturnType<typeof createInteractionView> | null = null;
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

function isHistoryEntry(value: unknown): value is TaskHistoryEntry {
  const record = object(value);
  return (
    typeof record?.taskId === "string" &&
    typeof record.objective === "string" &&
    typeof record.workspaceRoot === "string" &&
    typeof record.gatewayUrl === "string" &&
    typeof record.status === "string" &&
    typeof record.createdAt === "string"
  );
}

function loadHistory(): TaskHistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(historyKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isHistoryEntry).slice(0, maximumHistoryEntries) : [];
  } catch {
    return [];
  }
}

function saveHistory(): void {
  localStorage.setItem(historyKey, JSON.stringify(history.slice(0, maximumHistoryEntries)));
}

function formatHistoryTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ""
    : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function projectName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? "尚未选择项目";
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
  repositoryRootLabel.textContent = workspaceRoot
    ? projectName(workspaceRoot)
    : "尚未选择工作区";
  repositoryRootLabel.title = workspaceRoot;
  if (workspaceRoot) localStorage.setItem(workspaceKey, workspaceRoot);
  else localStorage.removeItem(workspaceKey);
  invalidateRepository(workspaceRoot);
  if (activeView === "repository" && workspaceRoot) void refreshRepository();
}

function setRepositoryTreeState(
  message: string,
  options: { browse?: boolean; error?: boolean } = {},
): void {
  repositoryTreeMessage.textContent = message;
  repositoryBrowse.hidden = options.browse !== true;
  repositoryTreeState.hidden = false;
  repositoryTree.hidden = true;
  if (options.error) repositoryTreeState.dataset.tone = "error";
  else delete repositoryTreeState.dataset.tone;
}

function resetRepositoryPreview(): void {
  repositoryPreviewGeneration += 1;
  selectedRepositoryEntry = null;
  repositoryFileTitle.textContent = "选择一个文件";
  repositoryFileTitle.removeAttribute("title");
  repositoryFileMeta.textContent = "";
  repositoryFileContent.textContent = "";
  repositoryPreviewNotice.hidden = true;
  delete repositoryPreviewNotice.dataset.tone;
  repositoryPreviewContent.hidden = true;
  repositoryPreviewEmpty.hidden = false;
}

function invalidateRepository(workspaceRoot: string): void {
  repositoryLoadGeneration += 1;
  repositoryLoadedRoot = "";
  repositoryRefresh.disabled = false;
  repositoryEntryCount.textContent = "0";
  repositoryTree.replaceChildren();
  resetRepositoryPreview();
  setRepositoryTreeState(
    workspaceRoot ? "打开仓库页面以加载文件。" : "选择一个本地代码仓库后即可浏览文件。",
    { browse: !workspaceRoot },
  );
}

function repositoryIcon(kind: RepositoryEntry["kind"]): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    kind === "directory" ? "M3.5 7.5h7l2-2h8v13h-17z" : "M6 3.5h8l4 4v13H6zM14 3.5v4h4",
  );
  svg.append(path);
  return svg;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function renderRepositoryEntries(
  result: RepositoryDirectoryResult,
  container: HTMLElement,
  generation: number,
): void {
  container.replaceChildren();
  for (const entry of result.entries) {
    const group = document.createElement("div");
    group.className = "repository-entry-group";
    group.setAttribute("role", "none");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "repository-entry";
    button.dataset.kind = entry.kind;
    button.dataset.path = entry.path;
    button.title = entry.path;
    button.setAttribute("role", "treeitem");

    const arrow = document.createElement("span");
    arrow.className = "repository-entry-arrow";
    arrow.textContent = "›";
    arrow.setAttribute("aria-hidden", "true");
    const icon = document.createElement("span");
    icon.className = "repository-entry-icon";
    icon.append(repositoryIcon(entry.kind));
    const name = document.createElement("span");
    name.className = "repository-entry-name";
    name.textContent = entry.name;
    button.append(arrow, icon, name);
    group.append(button);

    if (entry.kind === "directory") {
      const children = document.createElement("div");
      children.className = "repository-entry-children";
      children.setAttribute("role", "group");
      children.hidden = true;
      group.append(children);
      button.setAttribute("aria-expanded", "false");
      button.addEventListener("click", async () => {
        const opening = button.dataset.open !== "true";
        button.dataset.open = String(opening);
        button.setAttribute("aria-expanded", String(opening));
        children.hidden = !opening;
        if (!opening || children.dataset.loaded === "true") return;

        children.textContent = "正在加载…";
        children.classList.add("repository-entry-loading");
        try {
          const childResult = await window.bitAgent.listRepositoryDirectory({ path: entry.path });
          if (generation !== repositoryLoadGeneration) return;
          children.classList.remove("repository-entry-loading");
          children.dataset.loaded = "true";
          renderRepositoryEntries(childResult, children, generation);
          if (childResult.entries.length === 0) {
            children.textContent = "空目录";
            children.classList.add("repository-entry-loading");
          }
        } catch (error) {
          if (generation !== repositoryLoadGeneration) return;
          children.classList.add("repository-entry-loading", "is-error");
          children.textContent = error instanceof Error ? error.message : "目录读取失败";
        }
      });
    } else {
      button.addEventListener("click", () => void openRepositoryFile(entry, button));
    }

    container.append(group);
  }

  if (result.truncated) {
    const notice = document.createElement("p");
    notice.className = "repository-tree-notice";
    notice.textContent = "目录内容较多，仅显示前 500 项。";
    container.append(notice);
  }
}

async function openRepositoryFile(
  entry: RepositoryEntry,
  button: HTMLButtonElement,
): Promise<void> {
  const generation = ++repositoryPreviewGeneration;
  selectedRepositoryEntry?.removeAttribute("data-selected");
  selectedRepositoryEntry = button;
  button.dataset.selected = "true";
  repositoryFileTitle.textContent = entry.name;
  repositoryFileTitle.title = entry.path;
  repositoryFileMeta.textContent = entry.path;
  repositoryPreviewEmpty.hidden = true;
  repositoryPreviewContent.hidden = false;
  repositoryFileContent.textContent = "";
  repositoryPreviewNotice.hidden = false;
  repositoryPreviewNotice.textContent = "正在读取文件…";
  delete repositoryPreviewNotice.dataset.tone;

  try {
    const result = await window.bitAgent.readRepositoryFile({ path: entry.path });
    if (generation !== repositoryPreviewGeneration) return;
    repositoryFileContent.textContent = result.content;
    repositoryFileMeta.textContent = `${entry.path} · ${formatFileSize(result.size)}`;
    if (result.truncated) {
      repositoryPreviewNotice.textContent = "文件较大，仅预览前 1 MB。";
      repositoryPreviewNotice.hidden = false;
    } else {
      repositoryPreviewNotice.hidden = true;
    }
  } catch (error) {
    if (generation !== repositoryPreviewGeneration) return;
    repositoryPreviewNotice.dataset.tone = "error";
    repositoryPreviewNotice.textContent = error instanceof Error ? error.message : "文件读取失败";
  }
}

async function refreshRepository(): Promise<void> {
  const workspaceRoot = workspaceInput.value.trim();
  const generation = ++repositoryLoadGeneration;
  repositoryRefresh.disabled = true;
  repositoryEntryCount.textContent = "0";
  repositoryTree.replaceChildren();
  resetRepositoryPreview();

  if (!workspaceRoot) {
    repositoryRefresh.disabled = false;
    setRepositoryTreeState("选择一个本地代码仓库后即可浏览文件。", { browse: true });
    return;
  }

  setRepositoryTreeState("正在读取工作区…");
  try {
    await window.bitAgent.setRepositoryWorkspace(workspaceRoot);
    const result = await window.bitAgent.listRepositoryDirectory({ path: "" });
    if (generation !== repositoryLoadGeneration) return;
    repositoryLoadedRoot = workspaceRoot;
    repositoryEntryCount.textContent = result.truncated
      ? `${result.entries.length}+`
      : String(result.entries.length);
    repositoryTreeState.hidden = true;
    repositoryTree.hidden = false;
    renderRepositoryEntries(result, repositoryTree, generation);
    if (result.entries.length === 0) {
      setRepositoryTreeState("当前工作区为空。");
    }
  } catch (error) {
    if (generation !== repositoryLoadGeneration) return;
    setRepositoryTreeState(error instanceof Error ? error.message : "工作区读取失败", {
      browse: true,
      error: true,
    });
  } finally {
    if (generation === repositoryLoadGeneration) repositoryRefresh.disabled = false;
  }
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
    const workspaceRoot = workspaceInput.value.trim();
    if (workspaceRoot !== repositoryLoadedRoot) void refreshRepository();
  }
}

function renderHistory(): void {
  taskHistory.replaceChildren();
  historyCount.textContent = String(history.length);
  historyEmpty.hidden = history.length > 0;

  for (const entry of history) {
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
    taskHistory.append(button);
  }
}

function upsertHistory(entry: TaskHistoryEntry): void {
  history = [entry, ...history.filter((item) => item.taskId !== entry.taskId
    && !(entry.sessionId && item.sessionId === entry.sessionId && item.gatewayUrl === entry.gatewayUrl))];
  saveHistory();
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
  workspaceInput.disabled = busy;
  objectiveInput.disabled = busy;
  browseButton.disabled = busy;
  gatewayInput.disabled = busy;
  setModeDisabled(busy);
  for (const button of taskHistory.querySelectorAll<HTMLButtonElement>("button")) {
    button.disabled = submitting;
  }
}

function setStatus(status: string): void {
  statusText.textContent = statusLabels[status] ?? status;
  statusText.dataset.status = status;
  interactionView?.setStatus(status);
  updateActiveHistory({ status });
}

function applyInteractionTask(task: Record<string, unknown>): void {
  if (task.task_id !== activeTaskId) return;
  interactionView?.update(task);
  const status = typeof task.status === "string" ? task.status : "UNKNOWN";
  setStatus(status);
  setBusy(!terminalStatuses.has(status));
  if (status === "PAUSED") showThinking("已暂停，等待你继续或修改要求。");
  else if (status === "WAITING_FOR_INPUT") showThinking("Agent 提出了问题，请在下方回答。");
  else if (status === "RUNNING") showThinking("正在按当前要求继续执行…");
  if (terminalStatuses.has(status)) void loadResult();
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
      connection.textContent = `交互状态暂未同步：${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

function resetMetrics(): void {
  streamingText = "";
  streamingIdentity = "";
  tests.textContent = "-";
  lint.textContent = "-";
  acceptance.textContent = "-";
  rounds.textContent = "-";
  delete tests.dataset.passed;
  delete lint.dataset.passed;
  delete acceptance.dataset.passed;
  files.textContent = "无文件修改";
  files.classList.add("empty-copy");
  rawResult.textContent = "等待任务完成…";
}

function showConversation(objective: string): void {
  emptyState.hidden = true;
  userMessage.hidden = false;
  activityMessage.hidden = false;
  assistantMessage.hidden = false;
  objectiveDisplay.textContent = objective;
}

function setActivityPlaceholder(message: string): void {
  const dot = document.createElement("span");
  dot.className = "thinking-dot";
  activityEmpty.replaceChildren(dot, document.createTextNode(message));
  activityEmpty.hidden = false;
}

function showThinking(message = "Agent 正在分析项目并选择下一步操作…"): void {
  answer.replaceChildren();
  answer.dataset.state = "loading";
  const indicator = document.createElement("span");
  indicator.className = "thinking-indicator";
  indicator.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
  const copy = document.createElement("span");
  copy.textContent = message;
  answer.append(indicator, copy);
  errorActions.hidden = true;
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  setStatus("ERROR");
  assistantMessage.hidden = false;
  delete answer.dataset.state;
  renderMarkdown(answer, `### 任务未完成\n\n${message}`);
  errorActions.hidden = false;
  setBusy(false);
}

function appendPayload(pre: HTMLElement, value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
  for (const line of text.split("\n")) {
    const row = document.createElement("span");
    row.className = line.startsWith("+")
      ? "diff-add"
      : line.startsWith("-")
        ? "diff-remove"
        : line.startsWith("@@")
          ? "diff-hunk"
          : "payload-line";
    row.textContent = `${line}\n`;
    pre.append(row);
  }
}

function appendEvent(event: TaskEvent): void {
  // 切换对话后，旧任务仍可在后台执行，但它的事件不能写进新对话。
  if (event.taskId && event.taskId !== activeTaskId) return;
  if (event.event_type === "desktop_stream_ended") {
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
  if (event.event_type === "MODEL_TEXT_DELTA") {
    const data = object(event.data);
    if (!isMainAgentText(data)) return;
    const payload = object(data?.payload);
    if (typeof payload?.text !== "string") return;
    const identity = `${activeTaskId}:${String(payload.response_id)}`;
    if (identity !== streamingIdentity) { streamingIdentity = identity; streamingText = ""; }
    streamingText += payload.text;
    delete answer.dataset.state;
    renderMarkdown(answer, streamingText);
    return;
  }
  const data = object(event.data);
  if (typeof data?.status === "string") setStatus(data.status);
  if (["TASK_PAUSE_REQUESTED", "TASK_PAUSED", "TASK_RESUMED", "TASK_INTENT_UPDATED",
    "USER_QUESTION", "USER_ANSWERED", "QUESTION_DEFAULTED"].includes(event.event_type)) {
    void refreshInteraction();
  }
  if (event.event_type === "desktop_error") showError(data?.message ?? event.data);

  const presentation = eventPresentation(event);
  if (!presentation) return;
  const previous = activityCards.get(presentation.key);
  if (presentation.remove) {
    previous?.remove();
    activityCards.delete(presentation.key);
    eventCount = activityCards.size;
    activityCount.textContent = `${eventCount} 个操作`;
    activityEmpty.hidden = eventCount > 0;
    return;
  }

  const item = document.createElement("li");
  item.className = "activity-item";
  item.dataset.tone = presentation.tone;
  const details = document.createElement("wa-details");
  details.className = "operation-card";
  details.setAttribute("appearance", "plain");
  if (presentation.tone === "error") details.setAttribute("open", "");
  const summary = document.createElement("div");
  summary.className = "operation-summary";
  summary.slot = "summary";
  const dot = document.createElement("span");
  dot.className = "event-dot";
  const copy = document.createElement("span");
  copy.className = "operation-copy";
  const title = document.createElement("strong");
  title.textContent = presentation.title;
  const caption = document.createElement("span");
  caption.textContent = presentation.target || presentation.toolName || "Bit Agent";
  copy.append(title, caption);
  const time = document.createElement("time");
  time.textContent = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
  summary.append(dot, copy, time);
  const humanDetail = document.createElement("dl");
  humanDetail.className = "operation-meta";
  const addMeta = (label: string, value: string | undefined): void => {
    if (!value) return;
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    humanDetail.append(term, description);
  };
  addMeta("操作", presentation.title);
  addMeta("目标", presentation.target);
  addMeta("状态", presentation.status);
  addMeta("耗时", presentation.durationMs === undefined ? undefined : `${presentation.durationMs} ms`);
  addMeta("工具", presentation.toolName);
  addMeta("错误码", presentation.errorCode);
  const detail = document.createElement("pre");
  detail.className = "event-payload";
  appendPayload(detail, event.data);
  const technical = document.createElement("details");
  technical.className = "technical-detail";
  const technicalSummary = document.createElement("summary");
  technicalSummary.textContent = "查看技术详情";
  technical.append(technicalSummary, detail);
  details.append(summary, humanDetail, technical);
  item.append(details);
  if (previous) previous.replaceWith(item); else timeline.append(item);
  activityCards.set(presentation.key, item);
  eventCount = activityCards.size;
  activityCount.textContent = `${eventCount} 个操作`;
  activityEmpty.hidden = true;
  item.scrollIntoView({ block: "nearest" });
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
  delete answer.dataset.state;
  renderMarkdown(answer, summary.answer);
  renderChangedFiles(summary.changedFiles);
  renderVerificationState(tests, summary.testsPassed);
  renderVerificationState(lint, summary.qualityPassed);
  renderVerificationState(acceptance, summary.acceptanceStatus === "NOT_RUN" || summary.acceptanceStatus === "NOT_VERIFIED"
    ? null : summary.acceptanceStatus === "PASSED");
  if (summary.acceptanceStatus === "NOT_VERIFIED") acceptance.textContent = "未完成验证";
  rounds.textContent = summary.rounds === null ? "-" : String(summary.rounds);
  rawResult.textContent = JSON.stringify(payload, null, 2);
  errorActions.hidden = true;
  updateActiveHistory({ finalAnswer: summary.answer });
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

async function refreshSessions(append = false): Promise<void> {
  const gatewayUrl = gatewayInput.value.trim();
  const offset = append ? nextSessionOffset : 0;
  if (offset === null) return;
  const payload = await window.bitAgent.listSessions(gatewayUrl, offset);
  if (gatewayUrl !== gatewayInput.value.trim()) return;
  nextSessionOffset = typeof payload.next_offset === "number" ? payload.next_offset : null;
  element<HTMLButtonElement>("#more-sessions").hidden = nextSessionOffset === null;
  if (!Array.isArray(payload.sessions)) return;
  const loaded: TaskHistoryEntry[] = [];
  for (const raw of payload.sessions) {
    const session = object(raw);
    const task = object(session?.latest_task);
    if (typeof session?.session_id !== "string" || typeof task?.task_id !== "string") continue;
    const value: TaskHistoryEntry = {
      taskId: task.task_id, sessionId: session.session_id,
      objective: String(session.title ?? task.objective ?? "对话"),
      workspaceRoot: String(session.workspace_root ?? ""), gatewayUrl,
      status: String(task.status ?? "UNKNOWN"), createdAt: String(session.updated_at ?? ""),
      multiAgentMode: session.multi_agent_mode === "on" || session.multi_agent_mode === "off"
        ? session.multi_agent_mode : "auto",
    };
    loaded.push(value);
  }
  const identifiers = new Set(loaded.map((entry) => entry.sessionId));
  const remaining = history.filter((entry) => entry.gatewayUrl !== gatewayUrl || !identifiers.has(entry.sessionId));
  history = append ? [...remaining, ...loaded] : [...loaded, ...remaining];
  saveHistory();
  renderHistory();
}

function prepareRun(objective: string): void {
  interactionView?.reset();
  activeObjective = objective;
  taskIdText.textContent = objective;
  taskIdText.removeAttribute("title");
  eventCount = 0;
  timeline.replaceChildren();
  activityCards.clear();
  activityCount.textContent = "0 个操作";
  setActivityPlaceholder("正在等待 Agent 的下一步操作…");
  showConversation(objective);
  showThinking();
  resetMetrics();
  setBusy(true);
  setStatus("SUBMITTING");
}

async function runAgent(): Promise<void> {
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
  activeTaskId = null;
  const generation = ++viewGeneration;
  submitting = true;
  prepareRun(objective);
  try {
    if (previousSession) {
      const saved = await window.bitAgent.getSession({ gatewayUrl: gatewayInput.value.trim(), sessionId: previousSession });
      renderPreviousTurns(saved, null);
    }
    const task = await window.bitAgent.createTask({
      gatewayUrl: gatewayInput.value.trim(),
      objective,
      workspaceRoot,
      ...(previousSession ? { sessionId: previousSession } : {}),
      multiAgentMode: mode,
      permissionMode: permissionMode(),
    });
    if (generation !== viewGeneration) return;
    if (typeof task.task_id !== "string") throw new Error("Gateway 没有返回 task_id");
    activeTaskId = task.task_id;
    activeSessionId = typeof task.session_id === "string" ? task.session_id : null;
    interactionView?.update(task);
    taskIdText.title = `任务 ID：${activeTaskId}`;
    const status = typeof task.status === "string" ? task.status : "QUEUED";
    upsertHistory({
      taskId: activeTaskId,
      objective,
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
  clearPreviousTurns();
  interactionView?.reset();
  setBusy(true);
  taskIdText.textContent = entry.objective;
  taskIdText.title = `任务 ID：${entry.taskId}`;
  eventCount = 0;
  timeline.replaceChildren();
  activityCards.clear();
  activityCount.textContent = "历史任务";
  setActivityPlaceholder("正在载入任务状态…");
  showConversation(entry.objective);
  setStatus(entry.status);
  if (entry.finalAnswer) renderMarkdown(answer, entry.finalAnswer);
  else showThinking("正在载入历史任务结果…");
  renderHistory();

  try {
    const input = { gatewayUrl: entry.gatewayUrl, taskId: entry.taskId };
    if (entry.sessionId) {
      const saved = await window.bitAgent.getSession({ gatewayUrl: entry.gatewayUrl, sessionId: entry.sessionId });
      if (generation !== viewGeneration) return;
      renderPreviousTurns(saved, entry.taskId);
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
    setStatus(status);
    if (terminalStatuses.has(status)) {
      const payload = await window.bitAgent.getResult(input);
      if (generation !== viewGeneration) return;
      renderResult(payload);
      setBusy(false);
    } else {
      showThinking("任务仍在运行，正在恢复实时事件…");
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
  clearPreviousTurns();
  activeObjective = "";
  eventCount = 0;
  taskIdText.textContent = "新任务";
  taskIdText.removeAttribute("title");
  setStatus("IDLE");
  timeline.replaceChildren();
  activityCards.clear();
  emptyState.hidden = false;
  userMessage.hidden = true;
  activityMessage.hidden = true;
  assistantMessage.hidden = true;
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
repositoryBrowse.addEventListener("click", () => void browseWorkspace());
repositoryRefresh.addEventListener("click", () => void refreshRepository());
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
      connection.textContent = `Gateway 已连接，但本地会话列表不可用：${error instanceof Error ? error.message : String(error)}`;
    }
  } catch (error) {
    connection.textContent = error instanceof Error ? error.message : "连接失败";
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

objectiveInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.ctrlKey) {
    event.preventDefault();
    if (!runButton.disabled) void runAgent();
  }
});

cancelButton.addEventListener("click", async () => {
  try {
    cancelButton.disabled = true;
    showThinking("正在停止任务…");
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
  ...(activeTaskId ? { taskId: activeTaskId } : {}) }));
window.bitAgent.onTaskEvent(appendEvent);

onAgentModeChange((mode) => {
  updateActiveHistory({ multiAgentMode: mode });
  if (!activeSessionId) return;
  void window.bitAgent.setSessionMode({
    gatewayUrl: gatewayInput.value.trim(), sessionId: activeSessionId, mode,
  }).catch((error: unknown) => {
    connection.textContent = `模式尚未保存：${error instanceof Error ? error.message : String(error)}`;
  });
});

element<HTMLButtonElement>("#more-sessions").addEventListener("click", () => {
  void refreshSessions(true).catch((error: unknown) => {
    connection.textContent = error instanceof Error ? error.message : String(error);
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
