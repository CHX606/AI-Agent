/** 把统一格式差异解析成带新旧行号的行，并能配对成左右并排的行。 */
export type DiffKind = "hunk" | "add" | "remove" | "context" | "note";
export interface DiffRow { kind: DiffKind; text: string; oldLine: number | null; newLine: number | null }
export type SplitRow =
  | { kind: "hunk" | "note"; text: string }
  | { kind: "pair"; left: DiffRow | null; right: DiffRow | null };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u;

interface Cursor { oldLine: number; newLine: number; oldLeft: number; newLeft: number }

function hunkRow(match: RegExpExecArray, cursor: Cursor): DiffRow {
  cursor.oldLine = Number(match[1]);
  cursor.oldLeft = match[2] === undefined ? 1 : Number(match[2]);
  cursor.newLine = Number(match[3]);
  cursor.newLeft = match[4] === undefined ? 1 : Number(match[4]);
  return { kind: "hunk", text: match[0], oldLine: null, newLine: null };
}

function bodyRow(line: string, cursor: Cursor): DiffRow {
  const sign = line[0];
  const text = line.slice(1);
  if (sign === "+") {
    cursor.newLeft -= 1;
    return { kind: "add", text, oldLine: null, newLine: cursor.newLine++ };
  }
  if (sign === "-") {
    cursor.oldLeft -= 1;
    return { kind: "remove", text, oldLine: cursor.oldLine++, newLine: null };
  }
  cursor.oldLeft -= 1;
  cursor.newLeft -= 1;
  // 有的工具会把空的上下文行写成完全空行，而不是一个空格。
  return { kind: "context", text: sign === " " ? text : line, oldLine: cursor.oldLine++, newLine: cursor.newLine++ };
}

/** 文件头（---/+++、diff、index）只在块外识别，块内以 "--" 开头的删除行不会被误当成文件头。 */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const cursor: Cursor = { oldLine: 0, newLine: 0, oldLeft: 0, newLeft: 0 };
  const lines = diff.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const inHunk = cursor.oldLeft > 0 || cursor.newLeft > 0;
    if (line.startsWith("\\")) rows.push({ kind: "note", text: line.slice(1).trim(), oldLine: null, newLine: null });
    else if (inHunk) rows.push(bodyRow(line, cursor));
    else {
      const match = HUNK.exec(line);
      if (match) rows.push(hunkRow(match, cursor));
    }
  }
  return rows;
}

export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  return {
    added: rows.filter(row => row.kind === "add").length,
    removed: rows.filter(row => row.kind === "remove").length,
  };
}

/** 连续的删除和随后的新增逐行配对；多出来的一侧留空。 */
export function splitRows(rows: DiffRow[]): SplitRow[] {
  const result: SplitRow[] = [];
  let removed: DiffRow[] = [];
  let added: DiffRow[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index += 1) {
      result.push({ kind: "pair", left: removed[index] ?? null, right: added[index] ?? null });
    }
    removed = [];
    added = [];
  };
  for (const row of rows) {
    if (row.kind === "remove") {
      if (added.length) flush();
      removed.push(row);
    } else if (row.kind === "add") added.push(row);
    else {
      flush();
      result.push(row.kind === "context" ? { kind: "pair", left: row, right: row } : { kind: row.kind, text: row.text });
    }
  }
  flush();
  return result;
}
