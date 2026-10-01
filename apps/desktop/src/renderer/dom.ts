/** 渲染层共用的小工具：取界面元素、识别普通对象、格式化展示文字。 */

export function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`缺少界面元素：${selector}`);
  return found;
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 展示错误原文；去掉 Electron 给 IPC 错误加的“Error invoking remote method …”前缀。 */
export function errorText(error: unknown, fallback?: string): string {
  if (!(error instanceof Error)) return fallback ?? String(error);
  return error.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/u, "") || fallback || "操作失败";
}

export function projectName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? "尚未选择项目";
}

export function formatHistoryTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ""
    : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
