import type { Choice } from "./choice-menu";
import { projectName } from "./dom";
import { workspaceKey } from "./workspace-tree";

export const browseWorkspaceChoice = "__browse_workspace__";
const folderIcon = '<path d="M3.5 7.5h7l2-2h8v13h-17z"/>';
const addFolderIcon = folderIcon + '<path d="M12 10.5v5M9.5 13h5"/>';

/** 合并当前目录、添加过的目录和历史目录；同名目录保留完整路径用于辨认。 */
export function workspaceChoices(roots: string[], currentRoot: string): Choice[] {
  const seen = new Set<string>();
  const choices: Choice[] = [{
    value: "", label: "选择工作区", description: "选择这段新对话使用的本地文件夹", icon: folderIcon,
  }];
  for (const value of [currentRoot, ...roots]) {
    const root = value.trim();
    const key = workspaceKey(root);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    choices.push({ value: root, label: projectName(root), description: root, icon: folderIcon });
  }
  choices.push({
    value: browseWorkspaceChoice, label: "添加工作区…", description: "选择本机上的另一个文件夹", icon: addFolderIcon,
  });
  return choices;
}

/** 提交时固定用户所选目录；已有会话不能被改绑到别的工作区。 */
export function taskWorkspaceRoot(selectedRoot: string, sessionRoot: string | null): string {
  const selected = selectedRoot.trim();
  if (!workspaceKey(selected)) throw new Error("请选择本次对话使用的工作区");
  if (sessionRoot !== null && workspaceKey(selected) !== workspaceKey(sessionRoot)) {
    throw new Error("当前对话已绑定其他工作区，请新建对话后选择工作区");
  }
  return selected;
}
