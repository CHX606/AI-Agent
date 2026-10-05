/**
 * 侧边栏按工作区分组的对话列表：分组 + 在指定目录新开对话。
 * 添加过的目录、分组折叠状态保存在本机。
 */
import { projectName } from "./dom";
import type { TaskHistoryEntry } from "./task-history";
import "./sidebar.css";

const COLLAPSED_KEY = "bit-agent.collapsed-workspaces.v1";
const KNOWN_KEY = "bit-agent.workspaces.v1";
const MAX_KNOWN = 30;

/** Windows 路径大小写、分隔符与末尾斜杠不改变同一个目录的身份。 */
export function workspaceKey(root: string): string {
  return root.trim().replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
}

function readList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

function writeList(key: string, values: string[]): void {
  try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* 只影响下次打开时的列表 */ }
}

export function knownWorkspaces(): string[] { return readList(KNOWN_KEY); }

/** 记住用户添加或切换到的工作区，最近的排在前面。 */
export function rememberWorkspace(root: string): void {
  if (!root.trim()) return;
  const known = knownWorkspaces().filter(item => workspaceKey(item) !== workspaceKey(root));
  writeList(KNOWN_KEY, [root.trim(), ...known].slice(0, MAX_KNOWN));
}

export function forgetWorkspace(root: string): void {
  writeList(KNOWN_KEY, knownWorkspaces().filter(item => workspaceKey(item) !== workspaceKey(root)));
}

function toggleCollapsed(root: string, collapsed: boolean): void {
  const rest = readList(COLLAPSED_KEY).filter(item => item !== workspaceKey(root));
  writeList(COLLAPSED_KEY, collapsed ? [...rest, workspaceKey(root)] : rest);
}

export interface WorkspaceTreeOptions {
  entries: TaskHistoryEntry[];
  searching: boolean;
  activeWorkspace: string;
  disabled: boolean;
  renderEntry(entry: TaskHistoryEntry): HTMLElement;
  onNewConversation(root: string): void;
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
  if (!options.searching && options.activeWorkspace) add(options.activeWorkspace);
  for (const entry of options.entries) add(entry.workspaceRoot)?.entries.push(entry);
  if (!options.searching) for (const root of knownWorkspaces()) add(root);
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
    for (const entry of group.entries) items.append(options.renderEntry(entry));
  } else {
    const empty = document.createElement("p");
    empty.className = "workspace-group-empty";
    empty.textContent = "还没有对话，点 + 开始";
    items.append(empty);
  }
  return items;
}

function groupSection(group: WorkspaceGroup, collapsed: boolean, active: boolean,
  options: WorkspaceTreeOptions): HTMLElement {
  const section = document.createElement("section");
  section.className = "workspace-group";
  section.dataset.root = group.root;
  section.dataset.active = String(active);
  const header = document.createElement("div");
  header.className = "workspace-group-header";
  header.append(groupToggle(group.root, collapsed, options.onChange), newConversationButton(group.root, options));
  if (!group.entries.length && !active) header.append(removeWorkspaceButton(group.root, options.onChange));
  section.append(header, groupItems(group, collapsed, options));
  return section;
}

export function renderWorkspaceTree(container: HTMLElement, options: WorkspaceTreeOptions): void {
  const collapsed = new Set(readList(COLLAPSED_KEY));
  const activeKey = workspaceKey(options.activeWorkspace);
  container.replaceChildren();
  for (const [key, group] of workspaceGroups(options)) {
    container.append(groupSection(group, !options.searching && collapsed.has(key), key === activeKey, options));
  }
}
