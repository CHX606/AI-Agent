import "./choice-menu";
import type { ChoiceMenu } from "./choice-menu";
import { knownWorkspaces } from "./workspace-tree";
import { browseWorkspaceChoice, workspaceChoices } from "./workspace-options";
import "./workspace-chooser.css";

export interface WorkspaceChooserOptions {
  currentRoot(): string;
  historyRoots(): string[];
  isLocked(): boolean;
  onSelect(root: string): void;
  onBrowse(): Promise<void>;
  onError(error: unknown): void;
}

class WorkspaceChooser {
  private menu: ChoiceMenu;
  private disabled = false;

  constructor(parent: HTMLElement, private readonly options: WorkspaceChooserOptions) {
    this.menu = this.createMenu();
    parent.prepend(this.menu);
  }

  private createMenu(): ChoiceMenu {
    const menu = document.createElement("choice-menu");
    menu.id = "workspace-chooser";
    menu.className = "workspace-chooser";
    const current = this.options.currentRoot().trim();
    menu.configure({
      heading: "这段对话在哪个工作区执行？",
      label: "选择工作区",
      choices: workspaceChoices([...knownWorkspaces(), ...this.options.historyRoots()], current),
      value: current,
    });
    menu.disabled = this.disabled || this.options.isLocked();
    menu.addEventListener("change", () => { void this.choose(menu.value); });
    return menu;
  }

  private async choose(value: string): Promise<void> {
    if (this.disabled || this.options.isLocked()) { this.refresh(); return; }
    try {
      if (value === browseWorkspaceChoice) await this.options.onBrowse();
      else this.options.onSelect(value);
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.refresh();
    }
  }

  refresh(): void {
    const focused = this.menu.contains(document.activeElement);
    const next = this.createMenu();
    // 旧菜单先关闭，释放其 document 级点击监听。
    this.menu.disabled = true;
    this.menu.replaceWith(next);
    this.menu = next;
    if (focused) this.focus();
  }

  setDisabled(value: boolean): void {
    this.disabled = value;
    this.menu.disabled = value || this.options.isLocked();
  }

  focus(): void { this.menu.querySelector<HTMLButtonElement>(".choice-trigger")?.focus(); }
}

export function mountWorkspaceChooser(parent: HTMLElement, options: WorkspaceChooserOptions) {
  return new WorkspaceChooser(parent, options);
}
export type WorkspaceChooserControl = ReturnType<typeof mountWorkspaceChooser>;
