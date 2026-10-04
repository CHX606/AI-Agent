/**
 * 仓库页面，样式参照 VS Code：左侧资源管理器（紧凑的目录树、文件类型图标、缩进参考线），
 * 右侧编辑区（打开的文件标签、路径、带行号和语法高亮的只读代码、底部状态栏）。
 * 状态只在本模块内维护。
 */
import type { RepositoryDirectoryResult, RepositoryEntry, RepositoryFileResult } from "../shared/contracts";
import { element, errorText, formatFileSize, projectName } from "./dom";
import { fileIconElement } from "./file-icons";
import { highlight, languageFor } from "./syntax-highlight";
import "./code-view.css";

export interface RepositoryView {
  /** 工作区变化时调用；active 表示仓库页面当前可见，需要立即重新加载。 */
  setWorkspace(workspaceRoot: string, active: boolean): void;
  /** 切换到仓库页面时调用；工作区没变就沿用已加载的目录树。 */
  activate(): void;
}

/** 超过这个大小或行数只显示纯文本，保证大文件也能马上打开（VS Code 对大文件也会关掉着色）。 */
const HIGHLIGHT_MAX_CHARS = 400_000;
const HIGHLIGHT_MAX_LINES = 8_000;
const MAX_TABS = 12;
const LINE_HEIGHT = 20;
const EDITOR_PADDING_TOP = 8;

interface OpenFile {
  entry: RepositoryEntry;
  tab: HTMLElement;
  result?: RepositoryFileResult;
  error?: string;
  /** 每个文件各自记住滚动位置和当前行。 */
  scrollTop: number;
  line: number | null;
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
  const tabs = element<HTMLElement>("#repository-tabs");
  const breadcrumbs = element<HTMLElement>("#repository-breadcrumbs");
  const statusLeft = element<HTMLElement>("#repository-status-left");
  const statusRight = element<HTMLElement>("#repository-file-meta");
  const previewEmpty = element<HTMLElement>("#repository-preview-empty");
  const previewContent = element<HTMLElement>("#repository-preview-content");
  const previewNotice = element<HTMLElement>("#repository-preview-notice");
  const editor = element<HTMLElement>("#repository-editor");
  const gutter = editor.querySelector<HTMLElement>(".editor-gutter")!;
  const currentLine = editor.querySelector<HTMLElement>(".editor-current-line")!;
  const fileContent = element<HTMLElement>("#repository-file-content");

  // 每次重新加载或打开文件都加一；旧请求返回时据此丢弃结果。
  let loadGeneration = 0;
  let previewGeneration = 0;
  let loadedRoot = "";
  const openFiles = new Map<string, OpenFile>();
  let activePath: string | null = null;

  function setTreeState(message: string, state: { browse?: boolean; error?: boolean } = {}): void {
    treeMessage.textContent = message;
    browseButton.hidden = state.browse !== true;
    treeState.hidden = false;
    tree.hidden = true;
    if (state.error) treeState.dataset.tone = "error";
    else delete treeState.dataset.tone;
  }

  function markSelected(): void {
    for (const button of tree.querySelectorAll<HTMLElement>(".repository-entry[data-selected]")) {
      button.removeAttribute("data-selected");
    }
    if (!activePath) return;
    tree.querySelector<HTMLElement>(`.repository-entry[data-path="${CSS.escape(activePath)}"]`)?.setAttribute("data-selected", "true");
  }

  function showEmpty(): void {
    previewGeneration += 1;
    activePath = null;
    breadcrumbs.replaceChildren();
    statusLeft.textContent = "只读预览";
    statusRight.textContent = "";
    fileContent.textContent = "";
    gutter.textContent = "";
    currentLine.hidden = true;
    previewNotice.hidden = true;
    previewContent.hidden = true;
    previewEmpty.hidden = false;
    markSelected();
  }

  function closeAll(): void {
    openFiles.clear();
    tabs.replaceChildren();
    showEmpty();
  }

  function invalidate(workspaceRoot: string): void {
    loadGeneration += 1;
    loadedRoot = "";
    refreshButton.disabled = false;
    entryCount.textContent = "0";
    tree.replaceChildren();
    closeAll();
    setTreeState(
      workspaceRoot ? "打开仓库页面以加载文件。" : "选择一个本地代码仓库后即可浏览文件。",
      { browse: !workspaceRoot },
    );
  }

  const chevron = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';
  const folderClosed = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h5l1.5 1.5h6.5v8h-13z"/></svg>';
  const folderOpen = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h5l1.5 1.5h5v2"/><path d="M1.5 3.5v9h11l2-5.5h-11l-2 5.5"/></svg>';

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
      arrow.innerHTML = entry.kind === "directory" ? chevron : "";
      const iconHolder = document.createElement("span");
      iconHolder.className = "repository-entry-icon";
      if (entry.kind === "directory") iconHolder.innerHTML = folderClosed;
      else iconHolder.append(fileIconElement(entry.name));
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
        button.addEventListener("click", () => void toggleDirectory(entry, button, iconHolder, children, generation));
      } else {
        button.addEventListener("click", () => void openFile(entry));
      }
      container.append(group);
    }

    if (result.truncated) {
      const notice = document.createElement("p");
      notice.className = "repository-tree-notice";
      notice.textContent = "目录内容较多，仅显示前 500 项。";
      container.append(notice);
    }
    markSelected();
  }

  async function toggleDirectory(
    entry: RepositoryEntry,
    button: HTMLButtonElement,
    iconHolder: HTMLElement,
    children: HTMLElement,
    generation: number,
  ): Promise<void> {
    const opening = button.dataset.open !== "true";
    button.dataset.open = String(opening);
    button.setAttribute("aria-expanded", String(opening));
    iconHolder.innerHTML = opening ? folderOpen : folderClosed;
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

  function renderBreadcrumbs(path: string): void {
    breadcrumbs.replaceChildren();
    const parts = [projectName(options.currentWorkspace()), ...path.split("/").filter(Boolean)];
    parts.forEach((part, index) => {
      if (index > 0) {
        const separator = document.createElement("span");
        separator.className = "editor-crumb-separator";
        separator.innerHTML = chevron;
        breadcrumbs.append(separator);
      }
      const crumb = document.createElement("span");
      crumb.className = "editor-crumb";
      if (index === parts.length - 1) crumb.append(fileIconElement(part));
      crumb.append(part);
      breadcrumbs.append(crumb);
    });
  }

  function createTab(entry: RepositoryEntry): HTMLElement {
    const tab = document.createElement("div");
    tab.className = "editor-tab";
    tab.setAttribute("role", "tab");
    tab.title = entry.path;
    tab.tabIndex = 0;
    const label = document.createElement("span");
    label.className = "editor-tab-label";
    label.textContent = entry.name;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "editor-tab-close";
    close.setAttribute("aria-label", `关闭 ${entry.name}`);
    close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>';
    tab.append(fileIconElement(entry.name), label, close);
    tab.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".editor-tab-close")) closeFile(entry.path);
      else activate(entry.path);
    });
    // 中键关闭，和 VS Code 一样。
    tab.addEventListener("auxclick", (event) => { if (event.button === 1) closeFile(entry.path); });
    tab.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(entry.path); }
    });
    return tab;
  }

  function closeFile(path: string): void {
    const file = openFiles.get(path);
    if (!file) return;
    const order = [...openFiles.keys()];
    const index = order.indexOf(path);
    file.tab.remove();
    openFiles.delete(path);
    if (activePath !== path) return;
    const next = order[index + 1] ?? order[index - 1];
    if (next && openFiles.has(next)) activate(next);
    else showEmpty();
  }

  function rememberPosition(): void {
    const file = activePath ? openFiles.get(activePath) : undefined;
    if (file) file.scrollTop = editor.scrollTop;
  }

  function placeCurrentLine(file: OpenFile): void {
    currentLine.hidden = file.line === null;
    if (file.line !== null) currentLine.style.top = `${EDITOR_PADDING_TOP + (file.line - 1) * LINE_HEIGHT}px`;
  }

  function paintStatus(file: OpenFile, column = 1): void {
    const result = file.result;
    const language = languageFor(file.entry.path);
    statusLeft.textContent = file.line === null ? "只读预览" : `行 ${file.line}，列 ${column}`;
    if (!result) { statusRight.textContent = file.error ? "读取失败" : "正在读取…"; return; }
    const lines = result.content ? result.content.split("\n").length : 0;
    statusRight.textContent = [`${lines} 行`, "UTF-8", language?.name ?? "纯文本", formatFileSize(result.size)].join(" · ");
  }

  /** 把文件内容画进编辑区：左侧行号，右侧着色后的代码。 */
  function paintContent(file: OpenFile): void {
    const result = file.result!;
    const content = result.content;
    const lineCount = content.split("\n").length;
    gutter.textContent = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n");
    gutter.style.minWidth = `${Math.max(3, String(lineCount).length) + 2}ch`;
    const large = content.length > HIGHLIGHT_MAX_CHARS || lineCount > HIGHLIGHT_MAX_LINES;
    const tokens = highlight(content, large ? null : languageFor(file.entry.path));
    const fragment = document.createDocumentFragment();
    for (const token of tokens) {
      if (!token.kind) { fragment.append(token.text); continue; }
      const span = document.createElement("span");
      span.className = `tok-${token.kind}`;
      span.textContent = token.text;
      fragment.append(span);
    }
    fileContent.replaceChildren(fragment);
    const notices = [
      result.truncated ? "文件较大，仅预览前 1 MB。" : "",
      large && languageFor(file.entry.path) ? "文件较大，已关闭语法着色。" : "",
    ].filter(Boolean);
    previewNotice.hidden = notices.length === 0;
    previewNotice.textContent = notices.join(" ");
  }

  function activate(path: string): void {
    const file = openFiles.get(path);
    if (!file) return;
    if (activePath !== path) rememberPosition();
    activePath = path;
    for (const item of openFiles.values()) item.tab.setAttribute("aria-selected", String(item === file));
    file.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    renderBreadcrumbs(path);
    previewEmpty.hidden = true;
    previewContent.hidden = false;
    markSelected();
    delete previewNotice.dataset.tone;
    if (file.result) {
      paintContent(file);
      editor.scrollTop = file.scrollTop;
    } else {
      fileContent.textContent = "";
      gutter.textContent = "";
      previewNotice.hidden = false;
      previewNotice.textContent = file.error ?? "正在读取文件…";
      if (file.error) previewNotice.dataset.tone = "error";
    }
    placeCurrentLine(file);
    paintStatus(file);
  }

  async function openFile(entry: RepositoryEntry): Promise<void> {
    let file = openFiles.get(entry.path);
    if (!file) {
      // 标签太多时关掉最早打开、当前没在看的那个。
      if (openFiles.size >= MAX_TABS) {
        const oldest = [...openFiles.keys()].find((path) => path !== activePath);
        if (oldest) closeFile(oldest);
      }
      file = { entry, tab: createTab(entry), scrollTop: 0, line: null };
      openFiles.set(entry.path, file);
      tabs.append(file.tab);
    }
    activate(entry.path);
    if (file.result) return;
    const generation = ++previewGeneration;
    const target = file;
    try {
      target.result = await window.bitAgent.readRepositoryFile({ path: entry.path });
      delete target.error;
    } catch (error) {
      target.error = errorText(error, "文件读取失败");
    }
    if (openFiles.get(entry.path) === target && activePath === entry.path && generation === previewGeneration) {
      activate(entry.path);
    }
  }

  // 点代码某一行：高亮当前行，状态栏显示行和列（和 VS Code 一样）。
  editor.addEventListener("click", (event) => {
    const file = activePath ? openFiles.get(activePath) : undefined;
    if (!file?.result) return;
    const bounds = editor.getBoundingClientRect();
    const y = event.clientY - bounds.top + editor.scrollTop - EDITOR_PADDING_TOP;
    const lineCount = file.result.content.split("\n").length;
    file.line = Math.min(lineCount, Math.max(1, Math.floor(y / LINE_HEIGHT) + 1));
    let column = 1;
    const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (caret && fileContent.contains(caret.startContainer)) {
      const before = document.createRange();
      before.setStart(fileContent, 0);
      before.setEnd(caret.startContainer, caret.startOffset);
      const text = before.toString();
      column = text.length - text.lastIndexOf("\n");
    }
    placeCurrentLine(file);
    paintStatus(file, column);
  });

  async function refresh(): Promise<void> {
    const workspaceRoot = options.currentWorkspace();
    const generation = ++loadGeneration;
    refreshButton.disabled = true;
    entryCount.textContent = "0";
    tree.replaceChildren();
    closeAll();

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
