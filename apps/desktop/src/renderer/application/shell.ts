import type { ColorTheme } from "../../shared/contracts";
import { projectName } from "../dom";
import { rememberWorkspace, workspaceKey } from "../workspace-tree";
import type { RendererApp } from "./context";

function setTheme(app: RendererApp, theme: ColorTheme, syncWindow = true): void {
  const nextThemeLabel = theme === "dark" ? "浅色" : "暗色";
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("wa-dark", theme === "dark");
  document.documentElement.classList.toggle("wa-light", theme === "light");
  app.themeToggle.setAttribute("aria-label", `切换为${nextThemeLabel}主题`);
  app.themeToggle.title = `切换为${nextThemeLabel}主题`;
  if (syncWindow) window.bitAgent.setTheme(theme);
}

function setWorkspace(app: RendererApp, path: string): void {
  const workspaceRoot = path.trim();
  if (app.activeSessionId && workspaceKey(workspaceRoot) !== workspaceKey(app.activeWorkspaceRoot)) {
    app.workspaceInput.value = app.activeWorkspaceRoot;
    app.workspaceChooser?.refresh();
    return;
  }
  app.activeWorkspaceRoot = workspaceRoot;
  app.workspaceInput.value = workspaceRoot;
  app.workspaceName.textContent = workspaceRoot ? projectName(workspaceRoot) : "尚未选择项目";
  app.workspaceSummary.textContent = workspaceRoot || "选择本地代码仓库";
  app.workspaceSummary.title = workspaceRoot;
  if (workspaceRoot) localStorage.setItem(app.workspaceKey, workspaceRoot);
  else localStorage.removeItem(app.workspaceKey);
  // 选过的工作区留在侧边栏里，即使还没有对话。
  if (workspaceRoot) rememberWorkspace(workspaceRoot);
  app.repository.setWorkspace(workspaceRoot, app.activeView === "repository");
  app.renderHistory();
  app.workspaceChooser?.refresh();
}

function setActiveView(app: RendererApp, view: "tasks" | "repository"): void {
  app.activeView = view;
  app.shell.dataset.view = view;
  const showingTasks = view === "tasks";
  app.taskSidebarPane.hidden = !showingTasks;
  app.repositorySidebarPane.hidden = showingTasks;
  app.repositoryView.hidden = showingTasks;
  app.tasksNavigation.classList.toggle("is-active", showingTasks);
  app.repositoryNavigation.classList.toggle("is-active", !showingTasks);
  if (showingTasks) {
    app.tasksNavigation.setAttribute("aria-current", "page");
    app.repositoryNavigation.removeAttribute("aria-current");
  } else {
    app.repositoryNavigation.setAttribute("aria-current", "page");
    app.tasksNavigation.removeAttribute("aria-current");
    app.repository.activate();
  }
}

function setInspectorCollapsed(app: RendererApp, collapsed: boolean): void {
  app.shell.dataset.inspectorCollapsed = String(collapsed);
  app.inspectorToggle.setAttribute("aria-expanded", String(!collapsed));
  localStorage.setItem(app.inspectorKey, String(collapsed));
}

async function browseWorkspace(app: RendererApp): Promise<void> {
  const path = await window.bitAgent.selectWorkspace();
  if (path) app.setWorkspace(path);
}

export function createShellController(app: RendererApp) {
  return {
    setTheme: setTheme.bind(null, app),
    setWorkspace: setWorkspace.bind(null, app),
    setActiveView: setActiveView.bind(null, app),
    setInspectorCollapsed: setInspectorCollapsed.bind(null, app),
    browseWorkspace: browseWorkspace.bind(null, app),
  };
}

