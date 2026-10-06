/** 本机工作区身份、已添加目录与折叠状态。 */
const COLLAPSED_KEY = "bit-agent.collapsed-workspaces.v1";
const KNOWN_KEY = "bit-agent.workspaces.v1";
const MAX_KNOWN = 30;

export function workspaceKey(root: string): string {
  return root.trim().replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
}

function readList(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

function writeList(key: string, values: string[]): void {
  localStorage.setItem(key, JSON.stringify(values));
}

export function knownWorkspaces(): string[] { return readList(KNOWN_KEY); }

/** 打开已有工作区不会改变它的位置。 */
export function rememberWorkspace(root: string): void {
  if (!root.trim()) return;
  const known = knownWorkspaces();
  if (known.some(item => workspaceKey(item) === workspaceKey(root))) return;
  writeList(KNOWN_KEY, [...known, root.trim()].slice(-MAX_KNOWN));
}

export function forgetWorkspace(root: string): void {
  writeList(KNOWN_KEY, knownWorkspaces().filter(item => workspaceKey(item) !== workspaceKey(root)));
}

export function collapsedWorkspaces(): Set<string> { return new Set(readList(COLLAPSED_KEY)); }

export function toggleCollapsed(root: string, collapsed: boolean): void {
  const rest = readList(COLLAPSED_KEY).filter(item => item !== workspaceKey(root));
  writeList(COLLAPSED_KEY, collapsed ? [...rest, workspaceKey(root)] : rest);
}
