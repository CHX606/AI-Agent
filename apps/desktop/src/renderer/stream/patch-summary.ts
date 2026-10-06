import type { FileDiff } from "./tool-diff";

export interface PatchSummary {
  paths: string[];
  added?: number;
  removed?: number;
}

export function patchPaths(payload: Record<string, unknown>): PatchSummary | undefined {
  if (!Array.isArray(payload.affected_paths) || !payload.affected_paths.every(path => typeof path === "string")) return;
  return { paths: payload.affected_paths };
}

/** 从实际前后差异统计；只有 hunk 内的 +/- 才是正文，截断预览不能提供完整行数。 */
export function patchDiffSummary(files: FileDiff[]): PatchSummary {
  const paths = files.map(file => file.path);
  if (files.some(file => file.truncated)) return { paths };
  let added = 0;
  let removed = 0;
  for (const file of files) {
    let inHunk = false;
    for (const line of file.diff.split("\n")) {
      if (line.startsWith("@@ ")) inHunk = true;
      else if (inHunk && line.startsWith("+")) added += 1;
      else if (inHunk && line.startsWith("-")) removed += 1;
    }
  }
  return { paths, added, removed };
}

function pathIdentity(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  return globalThis.navigator?.platform.startsWith("Win") ? normalized.toLowerCase() : normalized;
}

/** 文件数去重，行数累计各次成功修改；缺少历史数据时不把调用次数当成文件数量。 */
export function mergePatchSummaries(changes: (PatchSummary | undefined)[]) {
  if (!changes.length || changes.some(change => !change)) return;
  const known = changes as PatchSummary[];
  const paths = new Set(known.flatMap(change => change.paths.map(pathIdentity)));
  const complete = known.every(change => change.added !== undefined && change.removed !== undefined);
  const added = known.reduce((total, change) => total + (change.added ?? 0), 0);
  const removed = known.reduce((total, change) => total + (change.removed ?? 0), 0);
  return { text: `修改了 ${paths.size} 个文件`, result: complete ? `+${added} −${removed}` : "" };
}
