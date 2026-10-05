import type { RepositoryDirectoryResult, RepositoryEntry } from "../../shared/contracts";
import { element, errorText, projectName } from "../dom";
import { fileIconElement, folderIconElement } from "../file-icons";
import { CHEVRON } from "./breadcrumbs";

interface TreeOptions {
  workspace: () => string;
  onBrowse: () => void;
  onOpen: (entry: RepositoryEntry) => void;
  onReset: () => void;
}

/** Workspace loading and lazy directory expansion. */
export class RepositoryTree {
  private readonly rootLabel = element<HTMLElement>("#repository-root-label");
  private readonly refreshButton = element<HTMLButtonElement>("#repository-refresh");
  private readonly browseButton = element<HTMLButtonElement>("#repository-browse");
  private readonly tree = element<HTMLElement>("#repository-tree");
  private readonly state = element<HTMLElement>("#repository-tree-state");
  private readonly message = element<HTMLElement>("#repository-tree-message");
  private readonly count = element<HTMLElement>("#repository-entry-count");
  private generation = 0;
  private loadedRoot = "";
  private activePath: string | null = null;

  constructor(private readonly options: TreeOptions) {
    this.refreshButton.addEventListener("click", () => void this.refresh());
    this.browseButton.addEventListener("click", options.onBrowse);
  }

  setWorkspace(workspace: string, active: boolean): void {
    this.rootLabel.textContent = workspace ? projectName(workspace) : "尚未选择工作区";
    this.rootLabel.title = workspace;
    this.generation += 1;
    this.loadedRoot = "";
    this.refreshButton.disabled = false;
    this.clear();
    this.setState(workspace ? "打开仓库页面以加载文件。" : "选择一个本地代码仓库后即可浏览文件。", !workspace);
    if (active && workspace) void this.refresh();
  }

  activate(): void {
    if (this.options.workspace() !== this.loadedRoot) void this.refresh();
  }

  select(path: string | null): void {
    this.activePath = path;
    for (const button of this.tree.querySelectorAll<HTMLElement>(".repository-entry[data-selected]")) {
      button.removeAttribute("data-selected");
    }
    if (!path) return;
    this.tree.querySelector<HTMLElement>(`.repository-entry[data-path="${CSS.escape(path)}"]`)?.setAttribute("data-selected", "true");
  }

  private setState(message: string, browse = false, error = false): void {
    this.message.textContent = message;
    this.browseButton.hidden = !browse;
    this.state.hidden = false;
    this.tree.hidden = true;
    if (error) this.state.dataset.tone = "error";
    else delete this.state.dataset.tone;
  }

  private clear(): void {
    this.count.textContent = "0";
    this.tree.replaceChildren();
    this.options.onReset();
  }

  private row(entry: RepositoryEntry): { button: HTMLButtonElement; icon: HTMLElement } {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "repository-entry";
    button.dataset.kind = entry.kind;
    button.dataset.path = entry.path;
    button.title = entry.path;
    button.setAttribute("role", "treeitem");
    const arrow = document.createElement("span");
    arrow.className = "repository-entry-arrow";
    arrow.innerHTML = entry.kind === "directory" ? CHEVRON : "";
    const icon = document.createElement("span");
    icon.className = "repository-entry-icon";
    icon.append(entry.kind === "directory" ? folderIconElement(entry.name) : fileIconElement(entry.name));
    const name = document.createElement("span");
    name.className = "repository-entry-name";
    name.textContent = entry.name;
    button.append(arrow, icon, name);
    return { button, icon };
  }

  private group(entry: RepositoryEntry, generation: number): HTMLElement {
    const group = document.createElement("div");
    group.className = "repository-entry-group";
    group.setAttribute("role", "none");
    const { button, icon } = this.row(entry);
    group.append(button);
    if (entry.kind !== "directory") {
      button.addEventListener("click", () => this.options.onOpen(entry));
      return group;
    }
    const children = document.createElement("div");
    children.className = "repository-entry-children";
    children.setAttribute("role", "group");
    children.hidden = true;
    group.append(children);
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => void this.toggleDirectory(entry, button, icon, children, generation));
    return group;
  }

  private render(result: RepositoryDirectoryResult, container: HTMLElement, generation: number): void {
    container.replaceChildren();
    for (const entry of result.entries) container.append(this.group(entry, generation));
    if (result.truncated) {
      const notice = document.createElement("p");
      notice.className = "repository-tree-notice";
      notice.textContent = "目录内容较多，仅显示前 500 项。";
      container.append(notice);
    }
    this.select(this.activePath);
  }

  private async toggleDirectory(
    entry: RepositoryEntry, button: HTMLButtonElement, icon: HTMLElement,
    children: HTMLElement, generation: number,
  ): Promise<void> {
    const opening = button.dataset.open !== "true";
    button.dataset.open = String(opening);
    button.setAttribute("aria-expanded", String(opening));
    icon.replaceChildren(folderIconElement(entry.name, opening));
    children.hidden = !opening;
    if (!opening || children.dataset.loaded === "true") return;
    children.textContent = "正在加载…";
    children.classList.add("repository-entry-loading");
    try {
      const result = await window.bitAgent.listRepositoryDirectory({ path: entry.path });
      if (generation !== this.generation) return;
      children.classList.remove("repository-entry-loading", "is-error");
      children.dataset.loaded = "true";
      this.render(result, children, generation);
      if (result.entries.length === 0) {
        children.textContent = "空目录";
        children.classList.add("repository-entry-loading");
      }
    } catch (error) {
      if (generation !== this.generation) return;
      children.classList.add("repository-entry-loading", "is-error");
      children.textContent = errorText(error, "目录读取失败");
    }
  }

  private async refresh(): Promise<void> {
    const workspace = this.options.workspace();
    const generation = ++this.generation;
    this.refreshButton.disabled = true;
    this.clear();
    if (!workspace) {
      this.refreshButton.disabled = false;
      this.setState("选择一个本地代码仓库后即可浏览文件。", true);
      return;
    }
    this.setState("正在读取工作区…");
    try {
      await window.bitAgent.setRepositoryWorkspace(workspace);
      const result = await window.bitAgent.listRepositoryDirectory({ path: "" });
      if (generation !== this.generation) return;
      this.loadedRoot = workspace;
      this.count.textContent = result.truncated ? `${result.entries.length}+` : String(result.entries.length);
      this.state.hidden = true;
      this.tree.hidden = false;
      this.render(result, this.tree, generation);
      if (result.entries.length === 0) this.setState("当前工作区为空。");
    } catch (error) {
      if (generation !== this.generation) return;
      this.setState(errorText(error, "工作区读取失败"), true, true);
    } finally {
      if (generation === this.generation) this.refreshButton.disabled = false;
    }
  }
}
