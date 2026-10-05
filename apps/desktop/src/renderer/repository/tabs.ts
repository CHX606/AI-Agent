import type { RepositoryEntry } from "../../shared/contracts";
import { element, errorText } from "../dom";
import { fileIconElement } from "../file-icons";
import { RepositoryPreview } from "./preview";
import type { OpenFile } from "./types";

const MAX_TABS = 12;

/** Open-file ownership, tab controls and asynchronous reads. */
export class RepositoryTabs {
  private readonly container = element<HTMLElement>("#repository-tabs");
  private readonly files = new Map<string, OpenFile>();
  private readonly preview: RepositoryPreview;
  private activePath: string | null = null;

  constructor(workspace: () => string, private readonly onSelect: (path: string | null) => void) {
    this.preview = new RepositoryPreview(workspace);
  }

  clear(): void {
    this.files.clear();
    this.container.replaceChildren();
    this.activePath = null;
    this.preview.clear();
    this.onSelect(null);
  }

  private closeButton(entry: RepositoryEntry): HTMLButtonElement {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "editor-tab-close";
    close.setAttribute("aria-label", `关闭 ${entry.name}`);
    close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>';
    return close;
  }

  private createTab(entry: RepositoryEntry): HTMLElement {
    const tab = document.createElement("div");
    tab.className = "editor-tab";
    tab.setAttribute("role", "tab");
    tab.title = entry.path;
    tab.tabIndex = 0;
    const label = document.createElement("span");
    label.className = "editor-tab-label";
    label.textContent = entry.name;
    tab.append(fileIconElement(entry.name), label, this.closeButton(entry));
    tab.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".editor-tab-close")) this.close(entry.path);
      else this.activate(entry.path);
    });
    tab.addEventListener("auxclick", (event) => { if (event.button === 1) this.close(entry.path); });
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.activate(entry.path);
    });
    return tab;
  }

  private close(path: string): void {
    const file = this.files.get(path);
    if (!file) return;
    const order = [...this.files.keys()];
    const index = order.indexOf(path);
    file.tab.remove();
    this.files.delete(path);
    if (this.activePath !== path) return;
    const next = order[index + 1] ?? order[index - 1];
    if (next && this.files.has(next)) this.activate(next);
    else {
      this.activePath = null;
      this.preview.clear();
      this.onSelect(null);
    }
  }

  private activate(path: string): void {
    const file = this.files.get(path);
    if (!file) return;
    this.activePath = path;
    for (const item of this.files.values()) item.tab.setAttribute("aria-selected", String(item === file));
    file.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    this.preview.show(file);
    this.onSelect(path);
  }

  private addFile(entry: RepositoryEntry): OpenFile {
    if (this.files.size >= MAX_TABS) {
      const oldest = [...this.files.keys()].find((path) => path !== this.activePath);
      if (oldest) this.close(oldest);
    }
    const file = { entry, tab: this.createTab(entry), scrollTop: 0, line: null };
    this.files.set(entry.path, file);
    this.container.append(file.tab);
    return file;
  }

  async open(entry: RepositoryEntry): Promise<void> {
    const file = this.files.get(entry.path) ?? this.addFile(entry);
    this.activate(entry.path);
    if (file.result) return;
    try {
      file.result = await window.bitAgent.readRepositoryFile({ path: entry.path });
      delete file.error;
    } catch (error) {
      file.error = errorText(error, "文件读取失败");
    }
    if (this.files.get(entry.path) === file && this.activePath === entry.path) this.activate(entry.path);
  }
}
