/**
 * 侧边栏按工作区分组的对话列表（参照 Claude 桌面版的多文件夹侧栏）：
 * 每个工作区是一个可折叠的文件夹，标题右侧的 + 在这个工作区新开对话。
 * 添加过但还没有对话的工作区也会列出来；折叠状态和工作区列表记在本机。
 */
import { projectName } from "./dom";
import type { TaskHistoryEntry } from "./task-history";
import "./sidebar.css";

const COLLAPSED_KEY = "bit-agent.collapsed-workspaces.v1";
const KNOWN_KEY = "bit-agent.workspaces.v1";
const MAX_KNOWN = 30;

/** Windows 路径不区分大小写，末尾斜杠也不算区别。 */
export function workspaceKey(root: string): string {
  return root.trim().replace(/[\\/]+$/u, "").toLowerCase();
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

/** 记住用户添加或切换到的工作区，最近的排在前面。 */
export function rememberWorkspace(root: string): void {
  if (!root.trim()) return;
  const known = readList(KNOWN_KEY).filter((item) => workspaceKey(item) !== workspaceKey(root));
  writeList(KNOWN_KEY, [root.trim(), ...known].slice(0, MAX_KNOWN));
}

export function forgetWorkspace(root: string): void {
  writeList(KNOWN_KEY, readList(KNOWN_KEY).filter((item) => workspaceKey(item) !== workspaceKey(root)));
}

function toggleCollapsed(root: string, collapsed: boolean): void {
  const rest = readList(COLLAPSED_KEY).filter((item) => item !== workspaceKey(root));
  writeList(COLLAPSED_KEY, collapsed ? [...rest, workspaceKey(root)] : rest);
}

export interface WorkspaceTreeOptions {
  entries: TaskHistoryEntry[];
  /** 搜索时只列出有匹配对话的工作区，并全部展开。 */
  searching: boolean;
  activeWorkspace: string;
  disabled: boolean;
  /** 画一条对话（main.ts 负责点击、重命名和删除）。 */
  renderEntry(entry: TaskHistoryEntry): HTMLElement;
  onNewConversation(root: string): void;
  /** 列表变化（折叠、移除）后需要重画。 */
  onChange(): void;
}

const CHEVRON = '<svg class="workspace-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';
const FOLDER = '<svg class="workspace-folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h7l2-2h8v13h-17z"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';

export function renderWorkspaceTree(container: HTMLElement, options: WorkspaceTreeOptions): void {
  const groups = new Map<string, { root: string; entries: TaskHistoryEntry[] }>();
  const add = (root: string) => {
    const key = workspaceKey(root);
    if (!key) return undefined;
    if (!groups.has(key)) groups.set(key, { root, entries: [] });
    return groups.get(key)!;
  };
  // 当前工作区总在最上面，其余按最近的对话排序，最后是还没有对话的工作区。
  if (!options.searching && options.activeWorkspace) add(options.activeWorkspace);
  for (const entry of options.entries) add(entry.workspaceRoot)?.entries.push(entry);
  if (!options.searching) for (const root of readList(KNOWN_KEY)) add(root);

  const collapsed = new Set(readList(COLLAPSED_KEY));
  const activeKey = workspaceKey(options.activeWorkspace);
  container.replaceChildren();
  for (const [key, group] of groups) {
    const isCollapsed = !options.searching && collapsed.has(key);
    const section = document.createElement("section");
    section.className = "workspace-group";
    section.dataset.root = group.root;
    section.dataset.active = String(key === activeKey);

    const header = document.createElement("div");
    header.className = "workspace-group-header";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "workspace-group-toggle";
    toggle.title = group.root;
    toggle.setAttribute("aria-expanded", String(!isCollapsed));
    toggle.innerHTML = `${CHEVRON}${FOLDER}<span class="workspace-group-name"></span>`;
    toggle.querySelector(".workspace-group-name")!.textContent = projectName(group.root);
    toggle.addEventListener("click", () => {
      toggleCollapsed(group.root, !isCollapsed);
      options.onChange();
    });
    const create = document.createElement("button");
    create.type = "button";
    create.className = "workspace-group-action";
    create.dataset.action = "new";
    create.title = `在“${projectName(group.root)}”中新建对话`;
    create.setAttribute("aria-label", create.title);
    create.innerHTML = PLUS;
    create.disabled = options.disabled;
    create.addEventListener("click", () => options.onNewConversation(group.root));
    header.append(toggle, create);
    // 没有对话、也不是当前工作区时，可以从列表里移除（不会动磁盘上的文件）。
    if (!group.entries.length && key !== activeKey) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "workspace-group-action";
      remove.dataset.action = "remove";
      remove.title = "从列表移除这个工作区（不删除文件）";
      remove.setAttribute("aria-label", remove.title);
      remove.innerHTML = CLOSE;
      remove.addEventListener("click", () => { forgetWorkspace(group.root); options.onChange(); });
      header.append(remove);
    }

    const items = document.createElement("div");
    items.className = "workspace-group-items";
    items.hidden = isCollapsed;
    if (group.entries.length) {
      for (const entry of group.entries) items.append(options.renderEntry(entry));
    } else {
      const empty = document.createElement("p");
      empty.className = "workspace-group-empty";
      empty.textContent = "还没有对话，点 + 开始";
      items.append(empty);
    }
    section.append(header, items);
    container.append(section);
  }
}
