import { element } from "../dom";
import { createRepositoryView } from "../repository-view";
import { createStreamView,type StreamView } from "../stream-view";
import { loadHistory } from "../task-history";
import type { RendererApp } from "./context";
import { internalGatewayUrl } from "./connection";

export function initializeState(app: RendererApp): void {
  initializeEnvironment(app);
  initializeInputs(app);
  initializePanels(app);
  initializeConversation(app);
  initializeComposer(app);
}

function initializeEnvironment(app: RendererApp): void {
  app.terminalStatuses = new Set(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]);
  app.statusLabels = {
  CANCELLATION_REQUESTED: "已停止",
  CANCELLED: "已停止",
  COMPLETED: "已完成",
  ERROR: "出错",
  FAILED: "失败",
  IDLE: "就绪",
  PARTIAL: "部分完成",
  QUEUED: "排队中",
  RUNNING: "执行中",
  PAUSE_REQUESTED: "已停止",
  PAUSED: "已停止",
  WAITING_FOR_INPUT: "等待回答",
  SUBMITTING: "正在提交",
  UNKNOWN: "状态未知",
};
  app.workspaceKey = "bit-agent.workspace-root.v1";
  app.inspectorKey = "bit-agent.inspector-collapsed.v1";
  app.sidebarKey = "bit-agent.sidebar-collapsed.v1";
  app.reportClientError = (kind: "exception" | "rejection", line?: number) => {
  void window.bitAgent.reportClientError({ kind, ...(line === undefined ? {} : { line }) })
    .then(message => { app.showError(new Error(message)); }).catch(() => {});
};
  app.initialTheme = window.bitAgent.colorTheme;
  app.shell = element<HTMLElement>(".shell");
  app.gatewayUrl = internalGatewayUrl(window.bitAgent.runtimeConfig);
  app.workspaceInput = element<HTMLInputElement>("#workspace");
  app.workspaceName = element<HTMLElement>("#workspace-name");
  app.workspaceSummary = element<HTMLElement>("#workspace-summary");
  app.objectiveInput = element<HTMLTextAreaElement>("#objective");
  app.objectiveDisplay = element<HTMLElement>("#objective-display");
}

function initializeInputs(app: RendererApp): void {
  app.runButton = element<HTMLButtonElement>("#run");
  app.retryButton = element<HTMLButtonElement>("#retry");
  app.newTaskButton = element<HTMLButtonElement>("#new-task");
  app.cancelButton = element<HTMLButtonElement>("#cancel");
  app.browseButton = element<HTMLButtonElement>("#browse");
  app.statusText = element<HTMLElement>("#status");
  app.taskIdText = element<HTMLElement>("#task-id");
  app.currentTurn = element<HTMLElement>("#current-turn");
  app.files = element<HTMLElement>("#changed-files");
  app.tests = element<HTMLElement>("#tests-state");
  app.lint = element<HTMLElement>("#lint-state");
  app.acceptance = element<HTMLElement>("#acceptance-state");
  app.verificationNotes = element<HTMLUListElement>("#verification-notes");
  app.rounds = element<HTMLElement>("#rounds");
  app.usageState = element<HTMLElement>("#usage-state");
  app.usageCard = element<HTMLElement>("#usage-card");
  app.connectionDot = element<HTMLElement>("#connection-dot");
  app.taskHistory = element<HTMLElement>("#task-history");
  app.historyCount = element<HTMLElement>("#history-count");
  app.historyEmpty = element<HTMLElement>("#history-empty");
  app.emptyState = element<HTMLElement>("#empty-state");
  app.errorActions = element<HTMLElement>("#error-actions");
  app.inspectorToggle = element<HTMLButtonElement>("#inspector-toggle");
  app.sidebarToggle = element<HTMLButtonElement>("#sidebar-toggle");
  app.inspectorClose = element<HTMLButtonElement>("#inspector-close");
  app.inspectorResize = element<HTMLElement>("#inspector-resize");
  app.themeToggle = element<HTMLButtonElement>("#theme-toggle");
  app.tasksNavigation = element<HTMLButtonElement>("#nav-tasks");
  app.repositoryNavigation = element<HTMLButtonElement>("#nav-repository");
  app.taskSidebarPane = element<HTMLElement>("#task-sidebar-pane");
}

function initializePanels(app: RendererApp): void {
  app.repositorySidebarPane = element<HTMLElement>("#repository-sidebar-pane");
  app.repositoryView = element<HTMLElement>("#repository-view");
  app.repository = createRepositoryView({
  currentWorkspace: () => app.workspaceInput.value.trim(),
  onBrowse: () => void app.browseWorkspace(),
});
}

function initializeConversation(app: RendererApp): void {
  app.activeTaskId = null;
  app.stoppedTaskId = null;
  app.stoppedTasks = new Set();
  app.activeSessionId = null;
  app.activeWorkspaceRoot = "";
  app.submitting = false;
  app.viewGeneration = 0;
  app.nextSessionOffset = 0;
  app.activeObjective = "";
  app.activeImages = [];
  app.activeAttachments = [];
  app.composerImages = null;
  app.rewindableTaskId = null;
  app.refreshTurnActions = null;
  app.replaying = false;
  app.history = loadHistory().map((entry) => ({ ...entry, gatewayUrl: app.gatewayUrl }));
  app.conversationScroller = element<HTMLElement>("#conversation");
  app.streamView = createStreamView({
  stream: element<HTMLOListElement>("#stream"),
  statusLine: element<HTMLElement>("#status-line"),
  scroller: app.conversationScroller,
  loadDiff: app.diffLoader(() => app.activeTaskId),
});
  app.processCache = new Map<string, Node[]>();
  app.processLoaders = new Map<string, { view: StreamView; answer: string; done(): void; fail(error: Error): void }>();
  app.searchResults = null;
  app.sessionSearch = element<HTMLInputElement>("#session-search");
  app.activeView = "tasks";
  app.interactionView = null;
  app.modelMenu = null;
  app.workspaceChooser = null;
  app.interactionRefreshSequence = 0;
  app.renameIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/></svg>`;
  app.deleteIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>`;
  app.searchTimer = undefined;
  app.searchSequence = 0;
}

function initializeComposer(app: RendererApp): void {
  app.defaultPlaceholder = app.objectiveInput.placeholder;
  app.supplementStatuses = new Set(["QUEUED", "RUNNING", "PAUSE_REQUESTED", "PAUSED"]);
  app.RUN_ICONS = {
  stopped: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v6a3 3 0 0 1-3 3H6"/><path d="m10 10-4 4 4 4"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v6a3 3 0 0 1-3 3H6"/><path d="m10 10-4 4 4 4"/></svg>',
  running: '<svg class="run-spinner" viewBox="0 0 24 24" aria-hidden="true"><circle class="run-track" cx="12" cy="12" r="9"/><path class="run-arc" d="M12 3a9 9 0 0 1 9 9"/><rect class="run-stop" x="9" y="9" width="6" height="6" rx="1.4"/></svg>',
  paused: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="run-play" d="M9.5 7.3v9.4c0 .7.7 1.1 1.3.7l7.2-4.7a.8.8 0 0 0 0-1.4l-7.2-4.7c-.6-.4-1.3 0-1.3.7z"/></svg>',
};
  app.RUN_LABELS = {
  send: "发送（Enter）",
  running: "停止这一轮",
  stopped: "已停止",
  paused: "继续执行",
  waiting: "在上方卡片里选择，或在输入框写下回答",
  stopping: "发送（Enter）",
};
  app.steerChoice = element<HTMLElement>("#steer-choice");
  app.composerContext = element<HTMLElement>(".composer-context");
  app.queued = [];
  app.queuedList = element<HTMLOListElement>("#queued-messages");
  app.permissionOrder = ["confirm", "edit", "read_only"] as const;
  app.resizingInspector = false;
}
