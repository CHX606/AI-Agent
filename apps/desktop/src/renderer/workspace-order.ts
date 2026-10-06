/** 侧栏工作区的手动顺序；不改变已添加目录及输入框目录选择。 */
import { workspaceKey } from "./workspace-state";

export const workspaceOrderKey = "bit-agent.workspace-order.v1";

function storedWorkspaceOrder(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(workspaceOrderKey) ?? "[]");
    return Array.isArray(value) ? value.filter((root): root is string => typeof root === "string").map(workspaceKey) : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

export function orderedWorkspaceRoots(roots: string[]): string[] {
  const unique = new Map(roots.map(root => [workspaceKey(root), root]));
  unique.delete("");
  const saved = storedWorkspaceOrder().filter(key => unique.has(key));
  const remaining = [...unique.keys()].filter(key => !saved.includes(key));
  return [...new Set([...saved, ...remaining])].map(key => unique.get(key)!);
}

export function saveWorkspaceOrder(roots: string[]): void {
  localStorage.setItem(workspaceOrderKey, JSON.stringify([...new Set(roots.map(workspaceKey).filter(Boolean))]));
}

/** 使用与现有对话拖放相同的前后插入规则，保留路径本身及其他工作区位置。 */
export function movedWorkspaceOrder(roots: string[], source: string, target: string, after: boolean): string[] {
  const sourceKey = workspaceKey(source), targetKey = workspaceKey(target);
  if (sourceKey === targetKey || !roots.some(root => workspaceKey(root) === sourceKey)
    || !roots.some(root => workspaceKey(root) === targetKey)) return [...roots];
  const moving = roots.find(root => workspaceKey(root) === sourceKey)!;
  const remaining = roots.filter(root => workspaceKey(root) !== sourceKey);
  remaining.splice(remaining.findIndex(root => workspaceKey(root) === targetKey) + Number(after), 0, moving);
  return remaining;
}
