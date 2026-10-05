/** Compose the repository tree, open-file tabs and read-only preview. */
import { RepositoryTabs } from "./repository/tabs";
import { RepositoryTree } from "./repository/tree";
import "./code-view.css";

export interface RepositoryView {
  setWorkspace(workspaceRoot: string, active: boolean): void;
  activate(): void;
}

export function createRepositoryView(options: {
  currentWorkspace: () => string;
  onBrowse: () => void;
}): RepositoryView {
  const tree = new RepositoryTree({
    workspace: options.currentWorkspace,
    onBrowse: options.onBrowse,
    onOpen: (entry) => void tabs.open(entry),
    onReset: () => tabs.clear(),
  });
  const tabs = new RepositoryTabs(options.currentWorkspace, (path) => tree.select(path));
  return tree;
}
