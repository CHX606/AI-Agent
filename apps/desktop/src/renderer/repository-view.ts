/** 仓库页面：按需展开的目录树和只读文件预览。状态只在本模块内维护。 */
import type { RepositoryDirectoryResult, RepositoryEntry } from "../shared/contracts";
import { element, errorText, formatFileSize, projectName } from "./dom";

export interface RepositoryView {
  /** 工作区变化时调用；active 表示仓库页面当前可见，需要立即重新加载。 */
  setWorkspace(workspaceRoot: string, active: boolean): void;
  /** 切换到仓库页面时调用；工作区没变就沿用已加载的目录树。 */
  activate(): void;
}

export function createRepositoryView(options: {
  currentWorkspace: () => string;
  onBrowse: () => void;
}): RepositoryView {
  const rootLabel = element<HTMLElement>("#repository-root-label");
  const refreshButton = element<HTMLButtonElement>("#repository-refresh");
  const browseButton = element<HTMLButtonElement>("#repository-browse");
  const tree = element<HTMLElement>("#repository-tree");
  const treeState = element<HTMLElement>("#repository-tree-state");
  const treeMessage = element<HTMLElement>("#repository-tree-message");
  const entryCount = element<HTMLElement>("#repository-entry-count");
  const fileTitle = element<HTMLElement>("#repository-file-title");
  const fileMeta = element<HTMLElement>("#repository-file-meta");
  const previewEmpty = element<HTMLElement>("#repository-preview-empty");
  const previewContent = element<HTMLElement>("#repository-preview-content");
  const previewNotice = element<HTMLElement>("#repository-preview-notice");
  const fileContent = element<HTMLElement>("#repository-file-content");

  // 每次重新加载或打开文件都加一；旧请求返回时据此丢弃结果。
  let loadGeneration = 0;
  let previewGeneration = 0;
  let loadedRoot = "";
  let selectedEntry: HTMLButtonElement | null = null;

  function setTreeState(message: string, state: { browse?: boolean; error?: boolean } = {}): void {
    treeMessage.textContent = message;
    browseButton.hidden = state.browse !== true;
    treeState.hidden = false;
    tree.hidden = true;
    if (state.error) treeState.dataset.tone = "error";
    else delete treeState.dataset.tone;
  }

  function resetPreview(): void {
    previewGeneration += 1;
    selectedEntry = null;
    fileTitle.textContent = "选择一个文件";
    fileTitle.removeAttribute("title");
    fileMeta.textContent = "";
    fileContent.textContent = "";
    previewNotice.hidden = true;
    delete previewNotice.dataset.tone;
    previewContent.hidden = true;
    previewEmpty.hidden = false;
  }

  function invalidate(workspaceRoot: string): void {
    loadGeneration += 1;
    loadedRoot = "";
    refreshButton.disabled = false;
    entryCount.textContent = "0";
    tree.replaceChildren();
    resetPreview();
    setTreeState(
      workspaceRoot ? "打开仓库页面以加载文件。" : "选择一个本地代码仓库后即可浏览文件。",
      { browse: !workspaceRoot },
    );
  }

  function icon(kind: RepositoryEntry["kind"]): SVGSVGElement {
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

  function renderEntries(result: RepositoryDirectoryResult, container: HTMLElement, generation: number): void {
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
      const iconHolder = document.createElement("span");
      iconHolder.className = "repository-entry-icon";
      iconHolder.append(icon(entry.kind));
      const name = document.createElement("span");
      name.className = "repository-entry-name";
      name.textContent = entry.name;
      button.append(arrow, iconHolder, name);
      group.append(button);

      if (entry.kind === "directory") {
        const children = document.createElement("div");
        children.className = "repository-entry-children";
        children.setAttribute("role", "group");
        children.hidden = true;
        group.append(children);
        button.setAttribute("aria-expanded", "false");
        button.addEventListener("click", () => void toggleDirectory(entry, button, children, generation));
      } else {
        button.addEventListener("click", () => void openFile(entry, button));
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

  async function toggleDirectory(
    entry: RepositoryEntry,
    button: HTMLButtonElement,
    children: HTMLElement,
    generation: number,
  ): Promise<void> {
    const opening = button.dataset.open !== "true";
    button.dataset.open = String(opening);
    button.setAttribute("aria-expanded", String(opening));
    children.hidden = !opening;
    if (!opening || children.dataset.loaded === "true") return;

    children.textContent = "正在加载…";
    children.classList.add("repository-entry-loading");
    try {
      const childResult = await window.bitAgent.listRepositoryDirectory({ path: entry.path });
      if (generation !== loadGeneration) return;
      children.classList.remove("repository-entry-loading");
      children.dataset.loaded = "true";
      renderEntries(childResult, children, generation);
      if (childResult.entries.length === 0) {
        children.textContent = "空目录";
        children.classList.add("repository-entry-loading");
      }
    } catch (error) {
      if (generation !== loadGeneration) return;
      children.classList.add("repository-entry-loading", "is-error");
      children.textContent = errorText(error, "目录读取失败");
    }
  }

  async function openFile(entry: RepositoryEntry, button: HTMLButtonElement): Promise<void> {
    const generation = ++previewGeneration;
    selectedEntry?.removeAttribute("data-selected");
    selectedEntry = button;
    button.dataset.selected = "true";
    fileTitle.textContent = entry.name;
    fileTitle.title = entry.path;
    fileMeta.textContent = entry.path;
    previewEmpty.hidden = true;
    previewContent.hidden = false;
    fileContent.textContent = "";
    previewNotice.hidden = false;
    previewNotice.textContent = "正在读取文件…";
    delete previewNotice.dataset.tone;

    try {
      const result = await window.bitAgent.readRepositoryFile({ path: entry.path });
      if (generation !== previewGeneration) return;
      fileContent.textContent = result.content;
      fileMeta.textContent = `${entry.path} · ${formatFileSize(result.size)}`;
      if (result.truncated) {
        previewNotice.textContent = "文件较大，仅预览前 1 MB。";
        previewNotice.hidden = false;
      } else {
        previewNotice.hidden = true;
      }
    } catch (error) {
      if (generation !== previewGeneration) return;
      previewNotice.dataset.tone = "error";
      previewNotice.textContent = errorText(error, "文件读取失败");
    }
  }

  async function refresh(): Promise<void> {
    const workspaceRoot = options.currentWorkspace();
    const generation = ++loadGeneration;
    refreshButton.disabled = true;
    entryCount.textContent = "0";
    tree.replaceChildren();
    resetPreview();

    if (!workspaceRoot) {
      refreshButton.disabled = false;
      setTreeState("选择一个本地代码仓库后即可浏览文件。", { browse: true });
      return;
    }

    setTreeState("正在读取工作区…");
    try {
      await window.bitAgent.setRepositoryWorkspace(workspaceRoot);
      const result = await window.bitAgent.listRepositoryDirectory({ path: "" });
      if (generation !== loadGeneration) return;
      loadedRoot = workspaceRoot;
      entryCount.textContent = result.truncated ? `${result.entries.length}+` : String(result.entries.length);
      treeState.hidden = true;
      tree.hidden = false;
      renderEntries(result, tree, generation);
      if (result.entries.length === 0) setTreeState("当前工作区为空。");
    } catch (error) {
      if (generation !== loadGeneration) return;
      setTreeState(errorText(error, "工作区读取失败"), { browse: true, error: true });
    } finally {
      if (generation === loadGeneration) refreshButton.disabled = false;
    }
  }

  refreshButton.addEventListener("click", () => void refresh());
  browseButton.addEventListener("click", options.onBrowse);

  return {
    setWorkspace(workspaceRoot, active) {
      rootLabel.textContent = workspaceRoot ? projectName(workspaceRoot) : "尚未选择工作区";
      rootLabel.title = workspaceRoot;
      invalidate(workspaceRoot);
      if (active && workspaceRoot) void refresh();
    },
    activate() {
      if (options.currentWorkspace() !== loadedRoot) void refresh();
    },
  };
}
