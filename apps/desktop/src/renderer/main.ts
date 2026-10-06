import "@awesome.me/webawesome/dist/components/details/details.js";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import { createComposerController } from "./application/composer";
import { connectRuntime } from "./application/connection";
import type { RendererApp } from "./application/context";
import { createEventsController } from "./application/events";
import { createHistoryController } from "./application/history";
import { createProcessesController } from "./application/processes";
import { createQueueController } from "./application/queue";
import { createResultController } from "./application/result";
import { createRunController } from "./application/run";
import { mountTurnActions } from "./application/rewind";
import { createShellController } from "./application/shell";
import { initializeState } from "./application/state";
import "./composer.css";
import { element,errorText } from "./dom";
import { createInteractionView } from "./interaction-view";
import { mountModelMenu } from "./model-menu";
import { mountProductControls } from "./product-controls";
import { mountProfileMenu } from "./profile-menu";
import { mountWorkspaceChooser } from "./workspace-chooser";
import { mountSidebarResize } from "./sidebar-resize";
import { mountTerminalPanel } from "./terminal/terminal-panel";
import { mountBrowserPane } from "./browser/browser-pane";
import { ComposerImages } from "./attachments/composer-images";
import { hasComposerContent } from "./application/message";
import {
onAgentModeChange
} from "./session-view";
import "./styles.css";

import { createStopController } from "./application/stop";

const app = {} as RendererApp;
Object.assign(app,
  createProcessesController(app),
  createShellController(app),
  createHistoryController(app),
  createComposerController(app),
  createQueueController(app),
  createEventsController(app),
  createResultController(app),
  createRunController(app), createStopController(app));
initializeState(app);
app.refreshTurnActions = mountTurnActions(app);
mountSidebarResize(app.shell);
app.composerImages = new ComposerImages(element<HTMLElement>(".composer-card"), app.objectiveInput,
  element<HTMLElement>(".composer-actions"), {
    changed: () => app.paintComposer(), disabled: () => app.submitting || app.composerMode() === "locked",
  });
app.workspaceChooser = mountWorkspaceChooser(app.composerContext, {
  currentRoot: () => app.workspaceInput.value.trim(),
  historyRoots: () => app.history.map(entry => entry.workspaceRoot),
  isLocked: () => Boolean(app.activeSessionId) || app.submitting || document.body.dataset.busy === "true",
  onSelect: app.setWorkspace,
  onBrowse: app.browseWorkspace,
  onError: app.showError,
});

window.addEventListener("error", event => app.reportClientError("exception", event.lineno));

window.addEventListener("unhandledrejection", () => app.reportClientError("rejection"));

document.documentElement.dataset.theme = app.initialTheme;

document.documentElement.classList.add("wa-theme-default");

app.objectiveInput.addEventListener("input", () => app.paintComposer());

app.browseButton.addEventListener("click", () => void app.browseWorkspace());

app.tasksNavigation.addEventListener("click", () => app.setActiveView("tasks"));

app.repositoryNavigation.addEventListener("click", () => app.setActiveView("repository"));

app.workspaceInput.addEventListener("change", () => app.setWorkspace(app.workspaceInput.value.trim()));

app.runButton.addEventListener("click", () => void app.primaryAction());

app.steerChoice.addEventListener("click", (event) => {
  const choice = (event.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.send;
  if (choice === "queue") app.enqueue();
  else if (choice === "steer") void app.runAgent();
  app.objectiveInput.focus();
});

app.retryButton.addEventListener("click", () => {
  app.objectiveInput.value = app.activeObjective || app.objectiveInput.value;
  if (app.activeImages.length) app.composerImages?.set(app.activeImages);
  void app.runAgent();
});

app.newTaskButton.addEventListener("click", () => {
  if (app.submitting) return;
  app.resetTask();
  app.setWorkspace("");
  app.workspaceChooser?.focus();
});

app.objectiveInput.addEventListener("keydown", (event) => {
  // 输入法组字时的回车只是确认候选词，不能发送。
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter" && !event.shiftKey) {
    // 空闲时发送；运行中是“引导”（立即交给正在运行的 Agent）；等回答时是回答。
    event.preventDefault();
    if (!app.submitting && hasComposerContent(app)) void app.runAgent();
  } else if (event.key === "Tab" && event.shiftKey) {
    event.preventDefault();
    app.cyclePermission();
  } else if (event.key === "Tab" && app.composerMode() === "supplement" && hasComposerContent(app)) {
    // 运行中按 Tab：排到这一轮结束后再发送。
    event.preventDefault();
    app.enqueue();
  }
});

app.cancelButton.addEventListener("click", () => void app.stopTask());

app.inspectorToggle.addEventListener("click", () => {
  // 浏览器和任务详情共用右侧一列：浏览器开着时，点这里切回任务详情。
  if (browserPane.isOpen()) {
    browserPane.close();
    app.setInspectorCollapsed(false);
    return;
  }
  app.setInspectorCollapsed(app.shell.dataset.inspectorCollapsed !== "true");
});

app.inspectorClose.addEventListener("click", () => app.setInspectorCollapsed(true));

const toggleSidebar = () => app.setSidebarCollapsed(app.shell.dataset.sidebarCollapsed !== "true");
app.sidebarToggle.addEventListener("click", toggleSidebar);
const terminalPanel = mountTerminalPanel({
  panel: element<HTMLElement>("#terminal-panel"),
  toggle: element<HTMLButtonElement>("#terminal-toggle"),
  workspace: () => app.activeWorkspaceRoot,
});
const browserPane = mountBrowserPane({
  shell: app.shell,
  pane: element<HTMLElement>("#browser-pane"),
  toggle: element<HTMLButtonElement>("#browser-toggle"),
  onShortcut: (shortcut) => {
    if (shortcut === "toggle-sidebar") toggleSidebar();
    else if (shortcut === "toggle-terminal" && app.activeView === "tasks") terminalPanel.toggle();
  },
});
// 对话里的网页链接在内置浏览器的新标签页打开；按住 Ctrl/Shift 点击时仍交给系统浏览器。
element<HTMLElement>("#conversation").addEventListener("click", (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!link || !/^https?:$/u.test(link.protocol)) return;
  event.preventDefault();
  browserPane.openInNewTab(link.href);
});
// Ctrl+B 收起/展开左侧栏，Ctrl+` 打开/隐藏终端，和 VS Code、Claude Code 一致。
// 焦点在终端里时 Ctrl+B 留给 Shell。
document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
  if (event.isComposing || document.querySelector("dialog[open]")) return;
  const key = event.key.toLowerCase();
  if (key === "`") {
    if (app.activeView !== "tasks") return;
    event.preventDefault();
    terminalPanel.toggle();
  } else if (key === "b" && !(event.target instanceof Element && event.target.closest(".terminal-panel"))) {
    event.preventDefault();
    toggleSidebar();
  }
});

app.themeToggle.addEventListener("click", () => {
  app.setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

app.inspectorResize.addEventListener("pointerdown", (event) => {
  if (window.innerWidth <= 900) return;
  app.resizingInspector = true;
  app.inspectorResize.setPointerCapture(event.pointerId);
  document.body.dataset.resizing = "true";
});

window.addEventListener("pointermove", (event) => {
  if (!app.resizingInspector) return;
  const width = Math.min(520, Math.max(280, window.innerWidth - event.clientX));
  document.documentElement.style.setProperty("--inspector-width", `${width}px`);
});

window.addEventListener("pointerup", () => {
  app.resizingInspector = false;
  delete document.body.dataset.resizing;
});

app.interactionView = createInteractionView({ current: app.requestInput, apply: app.applyInteractionTask });

mountProductControls(app.requestInput, () => ({ gatewayUrl: app.gatewayUrl,
  ...(app.activeTaskId ? { taskId: app.activeTaskId } : {}) }),
() => ({ gatewayUrl: app.gatewayUrl, workspaceRoot: app.workspaceInput.value.trim() }));

mountProfileMenu();

app.modelMenu = mountModelMenu(element<HTMLElement>(".composer-actions"), () => element<HTMLButtonElement>("#model-settings").click());

app.modelMenu.setDisabled(document.body.dataset.busy === "true");

window.bitAgent.onTaskEvent(app.appendEvent);

onAgentModeChange((mode) => {
  app.updateActiveHistory({ multiAgentMode: mode });
  if (!app.activeSessionId) return;
  void window.bitAgent.setSessionMode({
    gatewayUrl: app.gatewayUrl, sessionId: app.activeSessionId, mode,
  }).catch((error: unknown) => {
    app.connectionDot.title = `模式尚未保存：${errorText(error)}`;
  });
});

app.sessionSearch.addEventListener("input", () => {
  clearTimeout(app.searchTimer);
  const query = app.sessionSearch.value.trim();
  element<HTMLButtonElement>("#more-sessions").hidden = query !== "" || app.nextSessionOffset === null;
  app.searchTimer = setTimeout(() => void app.searchSessions(query), query ? 250 : 0);
});

element<HTMLButtonElement>("#more-sessions").addEventListener("click", () => {
  void app.refreshSessions(true).catch((error: unknown) => {
    app.connectionDot.title = errorText(error);
  });
});

app.setWorkspace("");

app.setInspectorCollapsed(localStorage.getItem(app.inspectorKey) === "true");

app.setSidebarCollapsed(localStorage.getItem(app.sidebarKey) === "true");

app.setTheme(app.initialTheme, false);

app.setActiveView("tasks");

app.renderHistory();

app.resetMetrics();

app.paintComposer();

void connectRuntime(app);
