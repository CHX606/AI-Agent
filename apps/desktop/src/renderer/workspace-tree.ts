/**
 * 侧边栏按工作区分组的对话列表：分组 + 在指定目录新开对话。
 * 添加过的目录、分组折叠状态保存在本机。
 */
import { projectName } from "./dom";
import type { TaskHistoryEntry } from "./task-history";
import { bindConversationDrag } from "./conversation-drag";
import { orderedConversations } from "./conversation-order";
import { bindWorkspaceDrag } from "./workspace-drag";
import { orderedWorkspaceRoots } from "./workspace-order";
import { collapsedWorkspaces, forgetWorkspace, knownWorkspaces, toggleCollapsed, workspaceKey } from "./workspace-state";
import "./sidebar.css";
export { forgetWorkspace, knownWorkspaces, rememberWorkspace, workspaceKey } from "./workspace-state";

export interface WorkspaceTreeOptions {
  entries: TaskHistoryEntry[];
  searching: boolean;
  activeWorkspace: string;
  disabled: boolean;
  renderEntry(entry: TaskHistoryEntry): HTMLElement;
  onNewConversation(root: string): void;
  onReorder(root: string, ids: string[]): void;
  onWorkspaceReorder(roots: string[]): void;
  onChange(): void;
}
interface WorkspaceGroup { root: string; entries: TaskHistoryEntry[] }

const CHEVRON = '<svg class="workspace-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';
const FOLDER = '<svg class="workspace-folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h7l2-2h8v13h-17z"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';

function workspaceGroups(options: WorkspaceTreeOptions): Map<string, WorkspaceGroup> {
  const groups = new Map<string, WorkspaceGroup>();
  const add = (root: string) => {
    const key = workspaceKey(root);
    if (!key) return undefined;
    if (!groups.has(key)) groups.set(key, { root, entries: [] });
    return groups.get(key)!;
  };
  if (!options.searching) for (const root of knownWorkspaces()) add(root);
  for (const entry of options.entries) add(entry.workspaceRoot)?.entries.push(entry);
  if (!options.searching && options.activeWorkspace) add(options.activeWorkspace);
  return groups;
}

function groupToggle(root: string, collapsed: boolean, onChange: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "workspace-group-toggle";
  button.title = root;
  button.setAttribute("aria-expanded", String(!collapsed));
  button.innerHTML = `${CHEVRON}${FOLDER}<span class="workspace-group-name"></span>`;
  button.querySelector(".workspace-group-name")!.textContent = projectName(root);
  button.addEventListener("click", () => { toggleCollapsed(root, !collapsed); onChange(); });
  return button;
}

function newConversationButton(root: string, options: WorkspaceTreeOptions): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "workspace-group-action";
  button.dataset.action = "new";
  button.title = `在“${projectName(root)}”中新建对话`;
  button.setAttribute("aria-label", button.title);
  button.innerHTML = PLUS;
  button.disabled = options.disabled;
  button.addEventListener("click", () => options.onNewConversation(root));
  return button;
}

function removeWorkspaceButton(root: string, onChange: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "workspace-group-action";
  button.dataset.action = "remove";
  button.title = "从列表移除这个工作区（不删除文件）";
  button.setAttribute("aria-label", button.title);
  button.innerHTML = CLOSE;
  button.addEventListener("click", () => { forgetWorkspace(root); onChange(); });
  return button;
}

function groupItems(group: WorkspaceGroup, collapsed: boolean, options: WorkspaceTreeOptions): HTMLDivElement {
  const items = document.createElement("div");
  items.className = "workspace-group-items";
  items.hidden = collapsed;
  if (group.entries.length) {
    const entries = orderedConversations(group.entries);
    for (const entry of entries) {
      const row = options.renderEntry(entry);
      bindConversationDrag(row, entry, entries, {
        disabled: options.disabled || options.searching, onReorder: options.onReorder,
      });
      items.append(row);
    }
  } else {
    const empty = document.createElement("p");
    empty.className = "workspace-group-empty";
    empty.textContent = "还没有对话，点 + 开始";
    items.append(empty);
  }
  return items;
}

function groupSection(group: WorkspaceGroup, collapsed: boolean, active: boolean,
  roots: string[], options: WorkspaceTreeOptions): HTMLElement {
  const section = document.createElement("section");
  section.className = "workspace-group";
  section.dataset.root = group.root;
  section.dataset.active = String(active);
  const header = document.createElement("div");
  header.className = "workspace-group-header";
  bindWorkspaceDrag(header, group.root, roots, {
    disabled: options.disabled || options.searching, onReorder: options.onWorkspaceReorder,
  });
  header.append(groupToggle(group.root, collapsed, options.onChange), newConversationButton(group.root, options));
  if (!group.entries.length && !active) header.append(removeWorkspaceButton(group.root, options.onChange));
  section.append(header, groupItems(group, collapsed, options));
  return section;
}

export function renderWorkspaceTree(container: HTMLElement, options: WorkspaceTreeOptions): void {
  const collapsed = collapsedWorkspaces();
  const activeKey = workspaceKey(options.activeWorkspace);
  const groups = workspaceGroups(options);
  const roots = orderedWorkspaceRoots([...groups.values()].map(group => group.root));
  container.replaceChildren();
  for (const root of roots) {
    const key = workspaceKey(root), group = groups.get(key)!;
    container.append(groupSection(group, !options.searching && collapsed.has(key), key === activeKey, roots, options));
  }
}
